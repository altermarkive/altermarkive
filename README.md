# keys

## Prompt

Implement remaining part of the code to read and print user names, passwords, current TOTP code and notes from `testdata/keys.kdbx` (KDBX format: https://keepass.info/help/kb/kdbx.html) - the password to the file is in `testdata/password.txt`. Important: You are only allowed to use standard library and `golang.org` packages, NO OTHER THIRD-PARTY LIBRARIES are to be used and if you are missing functionality needed for implementation then it must be implemented as art of this implementation. Your implementation will be evaluated separately on this criteria (so do keep this in mind while implementing):

- Clear code structure
- Simple, compact code
- Readability and ease of understanding of the code by a human software engineer
- Solid test coverage


# Summary

A complete KDBX4 (KeePass) reader in Go that decrypts `testdata/keys.kdbx` and prints each entry's user name, password, current TOTP code, and notes.

Dependencies: standard library only, plus `golang.org/x/crypto` (a `golang.org` package, used for Argon2 and ChaCha20).


## Running

```
go run .                                    # uses testdata/keys.kdbx + testdata/password.txt
go run . <kdbx-path> <password-path>        # explicit paths
```

Example output:

```
Title:    gov
UserName: president
Password: byW"js3Xb?'8Ew%ZA_l36VvB@w(+V2R}
TOTP:     825251        (changes every 60s)
Notes:
```

## Notes on the fixture

- The password is the **first line** of `testdata/password.txt`. The file's second line (`JBSWY3DPEHPK3PXP`) is a red herring: it is the entry's TOTP secret, not part of the password. `readPassword` reads only the first line.
- TOTP is stored the KeePassXC way: an `otp` string field holding an `otpauth://` URI (`secret=JBSWY3DPEHPK3PXP&period=60&digits=6&algorithm=SHA256`), so the code parses the URI and computes an RFC 6238 TOTP rather than reading a raw seed.

## Code structure

All files are `package main`, split by concern:

- `kdbx.go` — outer binary format: header parsing, Argon2 key derivation, header SHA-256/HMAC verification, the HMAC-protected block stream, AES-256-CBC / ChaCha20 decryption, and gzip decompression.
- `variantdict.go` — the KeePass VariantDictionary decoder used for the KDF parameters.
- `content.go` — inner header parsing, ChaCha20 unprotect of `Protected="True"` values (processed in document order so history copies keep the keystream aligned), and XML → `Entry` extraction (history is skipped).
- `totp.go` — otpauth URI parsing and HOTP/TOTP generation (SHA1/256/512, base32 secret, configurable digits/period).
- `main.go` — CLI wiring and output formatting.

Functionality implemented from scratch (no stdlib equivalent): the VariantDictionary parser, the KDBX HMAC block stream, the inner protected-value stream, and the full TOTP generator.

## Decryption pipeline

1. Parse the outer header (magic + type-length-value fields).
2. Derive the composite key: `SHA-256(SHA-256(password))`.
3. Transform it with Argon2 (parameters from the KDF VariantDictionary).
4. Master key `= SHA-256(masterSeed || transformedKey)`; HMAC base key `= SHA-512(masterSeed || transformedKey || 0x01)`.
5. Verify the header SHA-256 and HMAC (a HMAC mismatch means a wrong password).
6. Read and authenticate the HMAC block stream, concatenating the ciphertext.
7. Decrypt (AES-256-CBC or ChaCha20) and decompress (gzip).
8. Parse the inner header, decrypt protected values with the ChaCha20 inner stream, and unmarshal the XML into entries.

## Testing

Coverage 74.6%; CI-clean on `gofmt`, `go vet`, and `go test`.

- End-to-end decrypt-and-assert against the fixture.
- Deterministic TOTP check at a fixed timestamp.
- Wrong-password rejection.
- The six RFC 6238 reference vectors across SHA1/SHA256/SHA512.
- TOTP defaults and error handling (bad scheme/host/secret/algorithm).
- VariantDictionary round-trip, PKCS#7 unpadding, first-line password reading, and output formatting.
- The original KDBX header round-trip tests still pass unchanged.

## Scope

Supported: Argon2d/Argon2id KDF, AES-256-CBC / ChaCha20 outer cipher, ChaCha20 inner stream, and gzip/no compression — the combinations KDBX4 actually uses. Anything else (e.g. Twofish, Salsa20, AES-KDF) returns a clear error rather than adding unused breadth.
