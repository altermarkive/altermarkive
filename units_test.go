package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// encodeVariant builds the on-disk encoding of one VariantDictionary entry.
func encodeVariant(buf *bytes.Buffer, valueType byte, key string, value []byte) {
	buf.WriteByte(valueType)
	binary.Write(buf, binary.LittleEndian, uint32(len(key)))
	buf.WriteString(key)
	binary.Write(buf, binary.LittleEndian, uint32(len(value)))
	buf.Write(value)
}

func TestParseVariantDict(t *testing.T) {
	var buf bytes.Buffer
	binary.Write(&buf, binary.LittleEndian, uint16(0x0100)) // version

	encodeVariant(&buf, variantUint32, "P", []byte{4, 0, 0, 0})
	encodeVariant(&buf, variantUint64, "I", []byte{10, 0, 0, 0, 0, 0, 0, 0})
	encodeVariant(&buf, variantByteArray, "S", []byte{1, 2, 3})
	encodeVariant(&buf, variantString, "name", []byte("argon2"))
	buf.WriteByte(0) // terminator

	dict, err := parseVariantDict(buf.Bytes())
	if err != nil {
		t.Fatalf("parseVariantDict: %v", err)
	}
	if got := dict.uint64("P"); got != 4 {
		t.Errorf(`dict["P"] = %d, want 4`, got)
	}
	if got := dict.uint64("I"); got != 10 {
		t.Errorf(`dict["I"] = %d, want 10`, got)
	}
	if got := dict.value("S"); !bytes.Equal(got, []byte{1, 2, 3}) {
		t.Errorf(`dict["S"] = %v, want [1 2 3]`, got)
	}
	if got := dict["name"]; got != "argon2" {
		t.Errorf(`dict["name"] = %v, want "argon2"`, got)
	}
}

func TestPKCS7Unpad(t *testing.T) {
	valid, err := pkcs7Unpad([]byte{'a', 'b', 2, 2}, 16)
	if err != nil || !bytes.Equal(valid, []byte("ab")) {
		t.Fatalf("pkcs7Unpad valid = %q, %v", valid, err)
	}

	for name, data := range map[string][]byte{
		"empty":       {},
		"zero pad":    {'a', 0},
		"pad too big": {'a', 17},
		"mismatch":    {'a', 2, 3},
	} {
		if _, err := pkcs7Unpad(data, 16); err == nil {
			t.Errorf("%s: expected an error, got nil", name)
		}
	}
}

func TestPrintEntries(t *testing.T) {
	entries := []Entry{
		{Title: "with-otp", UserName: "alice", Password: "pw", OTP: "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ"},
		{Title: "no-otp", UserName: "bob", Password: "hunter2", Notes: "line1\nline2"},
	}
	var out bytes.Buffer
	printEntries(&out, entries, time.Unix(59, 0))
	text := out.String()

	for _, want := range []string{
		"Title:    with-otp", "UserName: alice", "TOTP:     263420",
		"Title:    no-otp", "TOTP:     (none)", "line1\n          line2",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("output is missing %q\n---\n%s", want, text)
		}
	}
}

func TestReadPasswordFirstLineOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "password.txt")
	if err := os.WriteFile(path, []byte("secret\nignored\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := readPassword(path)
	if err != nil {
		t.Fatalf("readPassword: %v", err)
	}
	if got != "secret" {
		t.Errorf("readPassword = %q, want %q", got, "secret")
	}
}
