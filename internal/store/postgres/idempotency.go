package postgres

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
)

// Canonicalisation strategy for the durable idempotency fingerprint (DATA §D,
// ADR-011, brief §6): the create request is reduced to a deterministic byte
// string and hashed with SHA-256, stored on api_idempotency.request_hash. Two
// requests with the same Idempotency-Key replay only when their fingerprints
// are byte-equal; a different body produces a different hash and the specified
// conflict.
//
// The hash is over a length-prefixed concatenation of the scalar identity
// fields and the CANONICAL form of the JSON payloads (def snapshot + input), so
// that key ordering and insignificant whitespace never change the result. Raw
// sensitive payloads are never stored — only the 32-byte digest.

// Fingerprint inputs are grouped so the encoder is testable in isolation.
type createFingerprint struct {
	DefName     string
	DefVersion  int
	BusinessKey string
	DefSnapshot json.RawMessage
	Input       json.RawMessage
}

// hashCreateRequest returns the SHA-256 fingerprint of a create request.
func hashCreateRequest(f createFingerprint) ([]byte, error) {
	h := sha256.New()
	// Length-prefix every field (8-byte big-endian length, then the bytes) so
	// field boundaries are unambiguous — no "ab"+"c" vs "a"+"bc" collisions.
	writeField := func(s string) {
		var lenb [8]byte
		binary.BigEndian.PutUint64(lenb[:], uint64(len(s)))
		_, _ = h.Write(lenb[:])
		_, _ = h.Write([]byte(s))
	}
	writeField(f.DefName)
	writeField(fmt.Sprintf("%d", f.DefVersion))
	writeField(f.BusinessKey)

	snap, err := canonicalJSON(f.DefSnapshot)
	if err != nil {
		return nil, fmt.Errorf("idempotency: canonicalise def snapshot: %w", err)
	}
	inp, err := canonicalJSON(f.Input)
	if err != nil {
		return nil, fmt.Errorf("idempotency: canonicalise input: %w", err)
	}
	writeField(string(snap))
	writeField(string(inp))
	return h.Sum(nil), nil
}

// canonicalJSON re-serialises raw JSON into a stable form: object keys sorted
// (encoding/json does this for maps), numbers kept in their original literal
// form (via json.Number to avoid 1.0/1 churn), and no insignificant whitespace.
// Null/absent input canonicalises to "null".
func canonicalJSON(raw []byte) ([]byte, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return []byte("null"), nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // preserve numeric literals exactly
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	// Re-encode. encoding/json sorts map[string]any keys, so object ordering is
	// canonical. Arrays preserve order (semantically significant).
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSpace(buf.Bytes()), nil
}
