package main

import (
	"os"
	"testing"
	"time"
)

// loadTestDatabase decrypts and parses the bundled fixture.
func loadTestDatabase(t *testing.T) []Entry {
	t.Helper()
	raw, err := os.ReadFile(defaultDatabasePath)
	if err != nil {
		t.Fatalf("read database: %v", err)
	}
	password, err := readPassword(defaultPasswordPath)
	if err != nil {
		t.Fatalf("read password: %v", err)
	}
	payload, err := decryptDatabase(raw, password)
	if err != nil {
		t.Fatalf("decrypt database: %v", err)
	}
	entries, err := parseEntries(payload)
	if err != nil {
		t.Fatalf("parse entries: %v", err)
	}
	return entries
}

func TestDecryptAndParseEntries(t *testing.T) {
	entries := loadTestDatabase(t)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}

	got := entries[0]
	want := Entry{
		Title:    "gov",
		UserName: "president",
		Password: `byW"js3Xb?'8Ew%ZA_l36VvB@w(+V2R}`,
		Notes:    "",
		OTP:      "otpauth://totp/gov:president?secret=JBSWY3DPEHPK3PXP&period=60&digits=6&issuer=gov&algorithm=SHA256",
	}
	if got != want {
		t.Errorf("entry mismatch:\n got %+v\nwant %+v", got, want)
	}
}

// TestEntryTOTPCode checks the TOTP derived from the fixture at a fixed time,
// so history-copy protected values do not throw off the keystream alignment.
func TestEntryTOTPCode(t *testing.T) {
	entries := loadTestDatabase(t)
	code, err := TOTPCode(entries[0].OTP, time.Unix(1700000000, 0))
	if err != nil {
		t.Fatalf("TOTP: %v", err)
	}
	if code != "205722" {
		t.Errorf("TOTP = %s, want 205722", code)
	}
}

func TestDecryptWrongPassword(t *testing.T) {
	raw, err := os.ReadFile(defaultDatabasePath)
	if err != nil {
		t.Fatalf("read database: %v", err)
	}
	if _, err := decryptDatabase(raw, "not-the-password"); err == nil {
		t.Fatal("expected an error for a wrong password, got nil")
	}
}
