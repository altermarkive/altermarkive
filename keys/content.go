package main

import (
	"bytes"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"io"
	"regexp"

	"golang.org/x/crypto/chacha20"
)

// Inner-header field identifiers (the header that precedes the XML payload).
const (
	innerEndOfHeader     byte = 0
	innerRandomStreamID  byte = 1
	innerRandomStreamKey byte = 2
)

// Inner random-stream cipher identifiers.
const innerStreamChaCha20 uint32 = 3

// Entry is a single decrypted password entry.
type Entry struct {
	Title    string
	UserName string
	Password string
	Notes    string
	OTP      string // otpauth:// URI, empty when the entry has no TOTP
}

// parseEntries decodes the inner payload (inner header + XML), decrypts the
// protected values and returns the current entries, ignoring history.
func parseEntries(payload []byte) ([]Entry, error) {
	document, stream, err := splitInnerHeader(payload)
	if err != nil {
		return nil, err
	}
	document, err = unprotectValues(document, stream)
	if err != nil {
		return nil, err
	}
	return decodeXML(document)
}

// splitInnerHeader consumes the inner header and returns the XML document plus
// the random stream used to decrypt protected values.
func splitInnerHeader(payload []byte) (xmlDoc []byte, stream *chacha20.Cipher, err error) {
	r := bytes.NewReader(payload)
	var streamID uint32
	var streamKey []byte
	for {
		var id byte
		var length uint32
		if err := binary.Read(r, binary.LittleEndian, &id); err != nil {
			return nil, nil, err
		}
		if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
			return nil, nil, err
		}
		data := make([]byte, length)
		if _, err := io.ReadFull(r, data); err != nil {
			return nil, nil, err
		}
		switch id {
		case innerEndOfHeader:
			doc, err := io.ReadAll(r)
			if err != nil {
				return nil, nil, err
			}
			stream, err := newInnerStream(streamID, streamKey)
			return doc, stream, err
		case innerRandomStreamID:
			streamID = binary.LittleEndian.Uint32(data)
		case innerRandomStreamKey:
			streamKey = data
		}
	}
}

// newInnerStream builds the keystream cipher that protects in-memory values.
// KDBX4 uses ChaCha20 keyed by SHA-512(streamKey): 32 bytes of key, 12 of nonce.
func newInnerStream(streamID uint32, streamKey []byte) (*chacha20.Cipher, error) {
	if streamID != innerStreamChaCha20 {
		return nil, fmt.Errorf("unsupported inner random stream %d", streamID)
	}
	hash := sha512.Sum512(streamKey)
	return chacha20.NewUnauthenticatedCipher(hash[:32], hash[32:44])
}

// protectedValue matches <Value Protected="True">base64</Value> entries.
var protectedValue = regexp.MustCompile(`(?s)Protected="True">([^<]*)</Value>`)

// unprotectValues replaces every protected value with its plaintext. The
// keystream must be consumed in document order across all entries (history
// included), so the values are processed exactly as they appear in the bytes.
func unprotectValues(document []byte, stream *chacha20.Cipher) ([]byte, error) {
	var decodeErr error
	result := protectedValue.ReplaceAllFunc(document, func(match []byte) []byte {
		encoded := protectedValue.FindSubmatch(match)[1]
		ciphertext, err := base64.StdEncoding.DecodeString(string(encoded))
		if err != nil {
			decodeErr = err
			return match
		}
		plaintext := make([]byte, len(ciphertext))
		stream.XORKeyStream(plaintext, ciphertext)

		var escaped bytes.Buffer
		xml.EscapeText(&escaped, plaintext)
		return append([]byte(">"), append(escaped.Bytes(), []byte("</Value>")...)...)
	})
	return result, decodeErr
}

// XML model. Groups nest recursively; an entry's history is deliberately not
// mapped so only current entries are returned.
type keepassFile struct {
	Root struct {
		Groups []xmlGroup `xml:"Group"`
	} `xml:"Root"`
}

type xmlGroup struct {
	Entries []xmlEntry `xml:"Entry"`
	Groups  []xmlGroup `xml:"Group"`
}

type xmlEntry struct {
	Strings []xmlString `xml:"String"`
}

type xmlString struct {
	Key   string `xml:"Key"`
	Value string `xml:"Value"`
}

func decodeXML(document []byte) ([]Entry, error) {
	var file keepassFile
	if err := xml.Unmarshal(document, &file); err != nil {
		return nil, err
	}
	var entries []Entry
	for _, group := range file.Root.Groups {
		collectEntries(group, &entries)
	}
	return entries, nil
}

func collectEntries(group xmlGroup, out *[]Entry) {
	for _, entry := range group.Entries {
		*out = append(*out, newEntry(entry))
	}
	for _, child := range group.Groups {
		collectEntries(child, out)
	}
}

func newEntry(x xmlEntry) Entry {
	fields := make(map[string]string, len(x.Strings))
	for _, s := range x.Strings {
		fields[s.Key] = s.Value
	}
	return Entry{
		Title:    fields["Title"],
		UserName: fields["UserName"],
		Password: fields["Password"],
		Notes:    fields["Notes"],
		OTP:      fields["otp"],
	}
}
