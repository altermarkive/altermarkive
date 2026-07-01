package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
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

func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("expected a path to a KDBX file as the first argument")
	}
	originalPath := os.Args[1]

	file, err := os.Open(originalPath)
	if err != nil {
		return err
	}
	defer file.Close()

	header, err := ReadKDBXHeader(file)
	if err != nil {
		return err
	}
	fmt.Printf("Read original KDBX file from %s header=%+v valid=true\n", originalPath, header)

	backupPath := originalPath + ".bak"
	backup, err := os.Create(backupPath)
	if err != nil {
		return err
	}
	defer backup.Close()

	if err := NewKDBXHeader().Write(backup); err != nil {
		return err
	}
	fmt.Printf("Wrote backup KDBX file to %s\n", backupPath)
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
