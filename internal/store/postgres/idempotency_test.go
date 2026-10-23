package postgres

import (
	"bytes"
	"encoding/json"
	"testing"
)

// TestCanonicalJSON_StableAcrossKeyOrder verifies the documented canonicalisation
// strategy (DATA §D): two logically-identical payloads written with different
// key order and whitespace must canonicalise to the same bytes, so an idempotency
// replay is detected by fingerprint equality rather than accidental byte form.
func TestCanonicalJSON_StableAcrossKeyOrder(t *testing.T) {
	a := []byte(`{"b":2,"a":{"y":"z","x":[1,2,3]},"n":1.50}`)
	b := []byte(`  { "a" : {"x" : [1,2,3], "y" : "z"} ,  "n" : 1.50 , "b" : 2 }  `)

	ca, err := canonicalJSON(a)
	if err != nil {
		t.Fatalf("canonical a: %v", err)
	}
	cb, err := canonicalJSON(b)
	if err != nil {
		t.Fatalf("canonical b: %v", err)
	}
	if !bytes.Equal(ca, cb) {
		t.Fatalf("canonical forms differ:\n a=%s\n b=%s", ca, cb)
	}
	// Numeric literal preserved (not turned into 1.5 -> exponent or int churn).
	if !bytes.Contains(ca, []byte(`1.50`)) {
		t.Fatalf("numeric literal not preserved: %s", ca)
	}
	// Keys are sorted in the canonical form.
	if bytes.Index(ca, []byte(`"a"`)) > bytes.Index(ca, []byte(`"b"`)) {
		t.Fatalf("expected sorted keys, got %s", ca)
	}
}

// TestCanonicalJSON_EmptyIsCanonicalNull documents the absent-payload form so a
// missing JSON body still fingerprints deterministically.
func TestCanonicalJSON_EmptyIsCanonicalNull(t *testing.T) {
	got, err := canonicalJSON(nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "null" {
		t.Fatalf("empty payload = %q, want null", got)
	}
}

// TestHashCreateRequest_OrderInsensitiveAndValueSensitive pins the two required
// properties of the fingerprint: key reordering never changes it, but any change
// to the request's actual content always does (the same-key/different-payload
// conflict in DATA §D depends on exactly this).
func TestHashCreateRequest_OrderInsensitiveAndValueSensitive(t *testing.T) {
	base := createFingerprint{
		DefName:     "room-reservation",
		DefVersion:  1,
		BusinessKey: "room:42:2026-12-20",
		DefSnapshot: json.RawMessage(`{"steps":["reserve-room","charge-payment"]}`),
		Input:       json.RawMessage(`{"guest":"a","nights":2}`),
	}
	reordered := base
	reordered.Input = json.RawMessage(`{ "nights" : 2 , "guest" : "a" }`) // same content, different form

	hBase, err := hashCreateRequest(base)
	if err != nil {
		t.Fatal(err)
	}
	hRe, err := hashCreateRequest(reordered)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(hBase, hRe) {
		t.Fatal("fingerprint changed on reformatting an identical request")
	}

	different := base
	different.Input = json.RawMessage(`{"guest":"a","nights":3}`) // nights 2 -> 3
	hDiff, err := hashCreateRequest(different)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(hBase, hDiff) {
		t.Fatal("fingerprint collided across different request content")
	}
	if len(hBase) != 32 {
		t.Fatalf("fingerprint length = %d, want 32 (SHA-256)", len(hBase))
	}
}
