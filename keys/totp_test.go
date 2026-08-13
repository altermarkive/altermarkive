package main

import (
	"encoding/base32"
	"fmt"
	"testing"
	"time"
)

// otpauthURI builds an otpauth URI from a raw (non-base32) shared secret.
func otpauthURI(secret string, digits, period int, algorithm string) string {
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte(secret))
	return fmt.Sprintf(
		"otpauth://totp/test?secret=%s&digits=%d&period=%d&algorithm=%s",
		encoded, digits, period, algorithm,
	)
}

// TestTOTPRFC6238 checks the reference vectors from RFC 6238, Appendix B.
func TestTOTPRFC6238(t *testing.T) {
	const (
		sha1Seed   = "12345678901234567890"
		sha256Seed = "12345678901234567890123456789012"
		sha512Seed = "1234567890123456789012345678901234567890123456789012345678901234"
	)
	cases := []struct {
		unix      int64
		seed      string
		algorithm string
		want      string
	}{
		{59, sha1Seed, "SHA1", "94287082"},
		{59, sha256Seed, "SHA256", "46119246"},
		{59, sha512Seed, "SHA512", "90693936"},
		{1111111109, sha1Seed, "SHA1", "07081804"},
		{1234567890, sha1Seed, "SHA1", "89005924"},
		{20000000000, sha1Seed, "SHA1", "65353130"},
	}
	for _, c := range cases {
		uri := otpauthURI(c.seed, 8, 30, c.algorithm)
		got, err := TOTPCode(uri, time.Unix(c.unix, 0))
		if err != nil {
			t.Fatalf("%s at %d: %v", c.algorithm, c.unix, err)
		}
		if got != c.want {
			t.Errorf("%s at %d = %s, want %s", c.algorithm, c.unix, got, c.want)
		}
	}
}

func TestTOTPDefaults(t *testing.T) {
	// No digits/period/algorithm: defaults are 6 digits, 30s, SHA1.
	uri := "otpauth://totp/test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	got, err := TOTPCode(uri, time.Unix(59, 0))
	if err != nil {
		t.Fatalf("TOTP: %v", err)
	}
	if want := "287082"; got != want { // last 6 digits of the RFC SHA1 vector
		t.Errorf("TOTP = %s, want %s", got, want)
	}
}

func TestTOTPInvalidURIs(t *testing.T) {
	cases := map[string]string{
		"wrong scheme":   "https://totp/test?secret=GEZDGNBV",
		"wrong host":     "otpauth://hotp/test?secret=GEZDGNBV",
		"missing secret": "otpauth://totp/test?digits=6",
		"bad algorithm":  "otpauth://totp/test?secret=GEZDGNBV&algorithm=MD5",
		"invalid base32": "otpauth://totp/test?secret=1111111",
	}
	for name, uri := range cases {
		if _, err := TOTPCode(uri, time.Unix(0, 0)); err == nil {
			t.Errorf("%s: expected an error, got nil", name)
		}
	}
}
