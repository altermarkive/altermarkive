package main

import (
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20"
)

const (
	kdbxHeaderSignature1      uint32 = 0x9AA2D903
	kdbxHeaderSignature2      uint32 = 0xB54BFB67
	kdbxHeaderFormatVersion40 uint32 = 0x00040000
	kdbxHeaderFormatVersion41 uint32 = 0x00040001
)

// KDBXHeader is the fixed 12-byte prefix of a KDBX file.
type KDBXHeader struct {
	Signature1    uint32
	Signature2    uint32
	FormatVersion uint32
}

// NewKDBXHeader builds a header with the current signatures and format version.
func NewKDBXHeader() KDBXHeader {
	return KDBXHeader{
		Signature1:    kdbxHeaderSignature1,
		Signature2:    kdbxHeaderSignature2,
		FormatVersion: kdbxHeaderFormatVersion41,
	}
}

// Write serializes the header as little-endian to the writer.
func (h KDBXHeader) Write(w io.Writer) error {
	for _, value := range []uint32{h.Signature1, h.Signature2, h.FormatVersion} {
		if err := binary.Write(w, binary.LittleEndian, value); err != nil {
			return err
		}
	}
	return nil
}

// ReadKDBXHeader deserializes a header from little-endian bytes read from r and
// validates its signatures and format version against known constants.
func ReadKDBXHeader(r io.Reader) (KDBXHeader, error) {
	var header KDBXHeader
	for _, field := range []*uint32{&header.Signature1, &header.Signature2, &header.FormatVersion} {
		if err := binary.Read(r, binary.LittleEndian, field); err != nil {
			return KDBXHeader{}, err
		}
	}
	if header.Signature1 != kdbxHeaderSignature1 {
		return KDBXHeader{}, fmt.Errorf(
			"KDBXHeader.Signature1: found %#010x, expected %#010x",
			header.Signature1, kdbxHeaderSignature1,
		)
	}
	if header.Signature2 != kdbxHeaderSignature2 {
		return KDBXHeader{}, fmt.Errorf(
			"KDBXHeader.Signature2: found %#010x, expected %#010x",
			header.Signature2, kdbxHeaderSignature2,
		)
	}
	switch header.FormatVersion {
	case kdbxHeaderFormatVersion40, kdbxHeaderFormatVersion41:
		return header, nil
	default:
		return KDBXHeader{}, fmt.Errorf(
			"KDBXHeader.FormatVersion: found %#010x, expected %#010x or %#010x",
			header.FormatVersion, kdbxHeaderFormatVersion40, kdbxHeaderFormatVersion41,
		)
	}
}

// Outer-header field identifiers (KDBX4 stores them as type-length-value records).
const (
	fieldEndOfHeader   byte = 0
	fieldCipherID      byte = 2
	fieldCompression   byte = 3
	fieldMasterSeed    byte = 4
	fieldEncryptionIV  byte = 7
	fieldKDFParameters byte = 11
)

// Cipher and key-derivation UUIDs, as stored in the outer header / KDF parameters.
var (
	cipherAES256   = decodeHex("31c1f2e6bf714350be5805216afc5aff")
	cipherChaCha20 = decodeHex("d6038a2b8b6f4cb5a524339a31dbb59a")
	kdfArgon2d     = decodeHex("ef636ddf8c29444b91f7a9a403e30a0c")
	kdfArgon2id    = decodeHex("9e298b1956db4773b23dfc3ec6f0a1e6")
)

// outerHeader holds the parsed outer header together with the exact bytes it
// occupies, which are needed to verify the header hash and HMAC.
type outerHeader struct {
	cipherID    []byte
	compression uint32
	masterSeed  []byte
	iv          []byte
	kdf         variantDict
	raw         []byte
}

// parseOuterHeader reads the magic and the type-length-value fields that follow.
func parseOuterHeader(r *bytes.Reader, all []byte) (outerHeader, error) {
	total := r.Len()
	if _, err := ReadKDBXHeader(r); err != nil {
		return outerHeader{}, err
	}

	fields := map[byte][]byte{}
	for {
		var id byte
		var length uint32
		if err := binary.Read(r, binary.LittleEndian, &id); err != nil {
			return outerHeader{}, err
		}
		if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
			return outerHeader{}, err
		}
		data := make([]byte, length)
		if _, err := io.ReadFull(r, data); err != nil {
			return outerHeader{}, err
		}
		if id == fieldEndOfHeader {
			break
		}
		fields[id] = data
	}

	kdf, err := parseVariantDict(fields[fieldKDFParameters])
	if err != nil {
		return outerHeader{}, fmt.Errorf("KDF parameters: %w", err)
	}
	return outerHeader{
		cipherID:    fields[fieldCipherID],
		compression: binary.LittleEndian.Uint32(fields[fieldCompression]),
		masterSeed:  fields[fieldMasterSeed],
		iv:          fields[fieldEncryptionIV],
		kdf:         kdf,
		raw:         all[:total-r.Len()],
	}, nil
}

// decryptDatabase parses a KDBX4 file, verifies it against the password and
// returns the decompressed inner payload (inner header followed by XML).
func decryptDatabase(raw []byte, password string) ([]byte, error) {
	r := bytes.NewReader(raw)
	header, err := parseOuterHeader(r, raw)
	if err != nil {
		return nil, err
	}

	transformedKey, err := header.deriveTransformedKey(password)
	if err != nil {
		return nil, err
	}
	masterKey := sha256Sum(header.masterSeed, transformedKey)
	hmacKey := sha512Sum(header.masterSeed, transformedKey, []byte{0x01})

	if err := verifyHeader(r, header.raw, hmacKey); err != nil {
		return nil, err
	}

	ciphertext, err := readHMACBlocks(r, hmacKey)
	if err != nil {
		return nil, err
	}
	plaintext, err := decryptCipher(header.cipherID, masterKey, header.iv, ciphertext)
	if err != nil {
		return nil, err
	}
	return decompress(header.compression, plaintext)
}

// deriveTransformedKey turns the password into the KDF-transformed key. The
// composite key is SHA-256 applied twice over the (single) password credential.
func (h outerHeader) deriveTransformedKey(password string) ([]byte, error) {
	inner := sha256.Sum256([]byte(password))
	composite := sha256.Sum256(inner[:])

	uuid := h.kdf.value("$UUID")
	salt := h.kdf.value("S")
	iters := uint32(h.kdf.uint64("I"))
	memory := uint32(h.kdf.uint64("M") / 1024) // bytes to KiB
	threads := uint8(h.kdf.uint64("P"))
	if v := h.kdf.uint64("V"); v != argon2.Version {
		return nil, fmt.Errorf("unsupported Argon2 version %#x", v)
	}

	switch {
	case bytes.Equal(uuid, kdfArgon2d):
		return argon2.Key(composite[:], salt, iters, memory, threads, 32), nil
	case bytes.Equal(uuid, kdfArgon2id):
		return argon2.IDKey(composite[:], salt, iters, memory, threads, 32), nil
	default:
		return nil, fmt.Errorf("unsupported key-derivation function %x", uuid)
	}
}

// verifyHeader checks the stored SHA-256 and HMAC-SHA-256 of the header. A HMAC
// mismatch means the derived key, and therefore the password, is wrong.
func verifyHeader(r *bytes.Reader, headerBytes, hmacKey []byte) error {
	storedSHA := make([]byte, sha256.Size)
	if _, err := io.ReadFull(r, storedSHA); err != nil {
		return err
	}
	if sum := sha256.Sum256(headerBytes); !bytes.Equal(storedSHA, sum[:]) {
		return errors.New("header integrity check failed: file is corrupt")
	}

	storedHMAC := make([]byte, sha256.Size)
	if _, err := io.ReadFull(r, storedHMAC); err != nil {
		return err
	}
	mac := hmac.New(sha256.New, blockHMACKey(hmacKey, 0xFFFFFFFFFFFFFFFF))
	mac.Write(headerBytes)
	if !hmac.Equal(storedHMAC, mac.Sum(nil)) {
		return errors.New("header HMAC check failed: wrong password or corrupt file")
	}
	return nil
}

// readHMACBlocks reads the HMAC-protected block stream and returns the
// concatenated ciphertext. Each block is [HMAC(32)][length(4)][data], and an
// empty block terminates the stream. Every block is authenticated before use.
func readHMACBlocks(r *bytes.Reader, hmacKey []byte) ([]byte, error) {
	var ciphertext bytes.Buffer
	for index := uint64(0); ; index++ {
		storedHMAC := make([]byte, sha256.Size)
		if _, err := io.ReadFull(r, storedHMAC); err != nil {
			return nil, err
		}
		var length uint32
		if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
			return nil, err
		}
		block := make([]byte, length)
		if _, err := io.ReadFull(r, block); err != nil {
			return nil, err
		}

		mac := hmac.New(sha256.New, blockHMACKey(hmacKey, index))
		binary.Write(mac, binary.LittleEndian, index)
		binary.Write(mac, binary.LittleEndian, length)
		mac.Write(block)
		if !hmac.Equal(storedHMAC, mac.Sum(nil)) {
			return nil, fmt.Errorf("block %d HMAC check failed: file is corrupt", index)
		}
		if length == 0 {
			return ciphertext.Bytes(), nil
		}
		ciphertext.Write(block)
	}
}

// decryptCipher decrypts the payload with the outer cipher named by cipherID.
func decryptCipher(cipherID, key, iv, ciphertext []byte) ([]byte, error) {
	switch {
	case bytes.Equal(cipherID, cipherAES256):
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		if len(ciphertext)%block.BlockSize() != 0 {
			return nil, errors.New("ciphertext is not a multiple of the AES block size")
		}
		plaintext := make([]byte, len(ciphertext))
		cipher.NewCBCDecrypter(block, iv).CryptBlocks(plaintext, ciphertext)
		return pkcs7Unpad(plaintext, block.BlockSize())
	case bytes.Equal(cipherID, cipherChaCha20):
		stream, err := chacha20.NewUnauthenticatedCipher(key, iv)
		if err != nil {
			return nil, err
		}
		plaintext := make([]byte, len(ciphertext))
		stream.XORKeyStream(plaintext, ciphertext)
		return plaintext, nil
	default:
		return nil, fmt.Errorf("unsupported cipher %x", cipherID)
	}
}

// decompress applies the compression named in the header (0 = none, 1 = gzip).
func decompress(compression uint32, data []byte) ([]byte, error) {
	switch compression {
	case 0:
		return data, nil
	case 1:
		gz, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		return io.ReadAll(gz)
	default:
		return nil, fmt.Errorf("unsupported compression algorithm %d", compression)
	}
}

// blockHMACKey derives the per-block HMAC key: SHA-512(index || baseKey).
func blockHMACKey(baseKey []byte, index uint64) []byte {
	var indexBytes [8]byte
	binary.LittleEndian.PutUint64(indexBytes[:], index)
	return sha512Sum(indexBytes[:], baseKey)
}

func sha256Sum(parts ...[]byte) []byte {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

func sha512Sum(parts ...[]byte) []byte {
	h := sha512.New()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// pkcs7Unpad removes and validates PKCS#7 padding.
func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("cannot unpad empty data")
	}
	pad := int(data[len(data)-1])
	if pad == 0 || pad > blockSize || pad > len(data) {
		return nil, errors.New("invalid PKCS#7 padding")
	}
	for _, b := range data[len(data)-pad:] {
		if int(b) != pad {
			return nil, errors.New("invalid PKCS#7 padding")
		}
	}
	return data[:len(data)-pad], nil
}
