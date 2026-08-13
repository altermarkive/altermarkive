package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"hash"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// totpConfig holds the parameters of a TOTP generator parsed from an
// otpauth://totp/... URI, with RFC 6238 defaults applied for missing values.
type totpConfig struct {
	secret    []byte
	digits    int
	period    int
	algorithm func() hash.Hash
}

// TOTPCode returns the current time-based one-time password for an otpauth URI.
func TOTPCode(uri string, now time.Time) (string, error) {
	config, err := parseOTPAuth(uri)
	if err != nil {
		return "", err
	}
	return config.codeAt(now), nil
}

func parseOTPAuth(uri string) (totpConfig, error) {
	u, err := url.Parse(uri)
	if err != nil {
		return totpConfig{}, err
	}
	if u.Scheme != "otpauth" || u.Host != "totp" {
		return totpConfig{}, fmt.Errorf("not a TOTP otpauth URI: %q", uri)
	}
	query := u.Query()

	secret, err := decodeBase32(query.Get("secret"))
	if err != nil {
		return totpConfig{}, fmt.Errorf("TOTP secret: %w", err)
	}
	algorithm, err := hashByName(query.Get("algorithm"))
	if err != nil {
		return totpConfig{}, err
	}
	return totpConfig{
		secret:    secret,
		digits:    intOrDefault(query.Get("digits"), 6),
		period:    intOrDefault(query.Get("period"), 30),
		algorithm: algorithm,
	}, nil
}

// codeAt implements the HOTP construction (RFC 4226) over the time-based
// counter (RFC 6238).
func (c totpConfig) codeAt(now time.Time) string {
	counter := uint64(now.Unix()) / uint64(c.period)
	var message [8]byte
	binary.BigEndian.PutUint64(message[:], counter)

	mac := hmac.New(c.algorithm, c.secret)
	mac.Write(message[:])
	sum := mac.Sum(nil)

	offset := sum[len(sum)-1] & 0x0F
	truncated := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7FFFFFFF
	code := truncated % pow10(c.digits)
	return fmt.Sprintf("%0*d", c.digits, code)
}

func decodeBase32(secret string) ([]byte, error) {
	secret = strings.ToUpper(strings.ReplaceAll(secret, " ", ""))
	secret = strings.TrimRight(secret, "=")
	if secret == "" {
		return nil, fmt.Errorf("missing secret")
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
}

func hashByName(name string) (func() hash.Hash, error) {
	switch strings.ToUpper(name) {
	case "", "SHA1":
		return sha1.New, nil
	case "SHA256":
		return sha256.New, nil
	case "SHA512":
		return sha512.New, nil
	default:
		return nil, fmt.Errorf("unsupported TOTP algorithm %q", name)
	}
}

func intOrDefault(s string, fallback int) int {
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return n
	}
	return fallback
}

func pow10(n int) uint32 {
	result := uint32(1)
	for range n {
		result *= 10
	}
	return result
}
