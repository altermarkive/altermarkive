package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

const (
	defaultDatabasePath = "testdata/keys.kdbx"
	defaultPasswordPath = "testdata/password.txt"
)

func run(args []string) error {
	databasePath := defaultDatabasePath
	passwordPath := defaultPasswordPath
	if len(args) > 0 {
		databasePath = args[0]
	}
	if len(args) > 1 {
		passwordPath = args[1]
	}

	password, err := readPassword(passwordPath)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(databasePath)
	if err != nil {
		return err
	}

	payload, err := decryptDatabase(raw, password)
	if err != nil {
		return err
	}
	entries, err := parseEntries(payload)
	if err != nil {
		return err
	}

	printEntries(os.Stdout, entries, time.Now())
	return nil
}

// readPassword returns the first line of the password file. The password is a
// single line; any following lines are ignored.
func readPassword(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return "", err
		}
		return "", fmt.Errorf("password file %s is empty", path)
	}
	return scanner.Text(), nil
}

func printEntries(w io.Writer, entries []Entry, now time.Time) {
	for i, entry := range entries {
		if i > 0 {
			fmt.Fprintln(w)
		}
		fmt.Fprintf(w, "Title:    %s\n", entry.Title)
		fmt.Fprintf(w, "UserName: %s\n", entry.UserName)
		fmt.Fprintf(w, "Password: %s\n", entry.Password)
		fmt.Fprintf(w, "TOTP:     %s\n", totpDisplay(entry.OTP, now))
		fmt.Fprintf(w, "Notes:    %s\n", indentNotes(entry.Notes))
	}
}

// totpDisplay renders the current TOTP code, or a hint when the entry has none.
func totpDisplay(otp string, now time.Time) string {
	if otp == "" {
		return "(none)"
	}
	code, err := TOTPCode(otp, now)
	if err != nil {
		return fmt.Sprintf("(invalid: %v)", err)
	}
	return code
}

// indentNotes keeps multi-line notes aligned under the "Notes:" label.
func indentNotes(notes string) string {
	return strings.ReplaceAll(notes, "\n", "\n          ")
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
