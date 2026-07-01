package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadsAndValidatesHeader(t *testing.T) {
	file, err := os.Open("tests/keys.kdbx")
	if err != nil {
		t.Fatalf("open tests/keys.kdbx: %v", err)
	}
	defer file.Close()

	if _, err := ReadKDBXHeader(file); err != nil {
		t.Fatalf("read header: %v", err)
	}
}

func TestWritesThenReadsAndValidatesHeader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kdbx_header_roundtrip.kdbx")

	writeFile, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	if err := NewKDBXHeader().Write(writeFile); err != nil {
		writeFile.Close()
		t.Fatalf("write header: %v", err)
	}
	if err := writeFile.Close(); err != nil {
		t.Fatalf("close %s: %v", path, err)
	}

	readFile, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer readFile.Close()

	if _, err := ReadKDBXHeader(readFile); err != nil {
		t.Fatalf("read header: %v", err)
	}
}
