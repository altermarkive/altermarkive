package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
)

// variantDict is a KeePass VariantDictionary: an ordered set of typed,
// string-keyed values used to carry the KDF parameters. Only the value types
// this reader needs are decoded; the rest are kept as their raw bytes.
type variantDict map[string]any

// VariantDictionary value type tags.
const (
	variantUint32    byte = 0x04
	variantUint64    byte = 0x05
	variantBool      byte = 0x08
	variantInt32     byte = 0x0C
	variantInt64     byte = 0x0D
	variantString    byte = 0x18
	variantByteArray byte = 0x42
)

// parseVariantDict decodes a VariantDictionary: a 2-byte version followed by
// entries of [type][keyLen][key][valueLen][value], terminated by a zero type.
func parseVariantDict(data []byte) (variantDict, error) {
	r := bytes.NewReader(data)
	var version uint16
	if err := binary.Read(r, binary.LittleEndian, &version); err != nil {
		return nil, err
	}

	dict := variantDict{}
	for {
		var valueType byte
		if err := binary.Read(r, binary.LittleEndian, &valueType); err != nil {
			return nil, err
		}
		if valueType == 0 {
			return dict, nil
		}
		key, err := readLengthPrefixed(r)
		if err != nil {
			return nil, err
		}
		value, err := readLengthPrefixed(r)
		if err != nil {
			return nil, err
		}

		switch valueType {
		case variantUint32, variantInt32:
			dict[string(key)] = binary.LittleEndian.Uint32(value)
		case variantUint64, variantInt64:
			dict[string(key)] = binary.LittleEndian.Uint64(value)
		case variantBool:
			dict[string(key)] = value[0] != 0
		case variantString:
			dict[string(key)] = string(value)
		case variantByteArray:
			dict[string(key)] = value
		default:
			return nil, fmt.Errorf("unknown VariantDictionary value type %#x", valueType)
		}
	}
}

func readLengthPrefixed(r *bytes.Reader) ([]byte, error) {
	var length uint32
	if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
		return nil, err
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// value returns a byte-array entry, or nil when absent.
func (d variantDict) value(key string) []byte {
	b, _ := d[key].([]byte)
	return b
}

// uint64 returns an integer entry stored as either a uint32 or a uint64.
func (d variantDict) uint64(key string) uint64 {
	switch v := d[key].(type) {
	case uint64:
		return v
	case uint32:
		return uint64(v)
	default:
		return 0
	}
}

// decodeHex decodes a compile-time-constant hex string, panicking on malformed
// input. It is used only for the fixed cipher and KDF identifier constants.
func decodeHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}
