package id

import (
	"bytes"
	"regexp"
	"testing"
)

var canonical = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestNewIsCanonicalV7(t *testing.T) {
	got := New()
	if !canonical.MatchString(got) {
		t.Fatalf("New() = %q is not canonical lowercase UUIDv7 (version nibble 7, variant 10xx)", got)
	}
	if !IsV7(got) {
		t.Fatalf("IsV7(%q) = false", got)
	}
}

func TestUniqueness(t *testing.T) {
	const n = 10000
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		s := New()
		if _, dup := seen[s]; dup {
			t.Fatalf("duplicate id %q generated", s)
		}
		seen[s] = struct{}{}
	}
}

// The data contract depends on v7 time-ordering. google/uuid guarantees
// in-process monotonicity, so sequentially generated ids must sort ascending.
func TestMonotonicOrdering(t *testing.T) {
	const n = 5000
	prev := New()
	for i := 0; i < n; i++ {
		cur := New()
		if cur <= prev {
			t.Fatalf("ids not strictly increasing: prev=%q cur=%q (i=%d)", prev, cur, i)
		}
		prev = cur
	}
}

// Deterministic seam: fixed entropy yields a reproducible random-bit tail,
// proving the reader is actually wired through (structure still valid v7).
func TestNewFromEntropyDeterministicTail(t *testing.T) {
	fill := bytes.Repeat([]byte{0xAB}, 16)
	a, err := NewFromEntropy(bytes.NewReader(fill))
	if err != nil {
		t.Fatalf("NewFromEntropy: %v", err)
	}
	if !IsV7(a) {
		t.Fatalf("entropy-seeded id is not v7: %q", a)
	}
	// rand_b occupies the final 8 bytes (16 hex chars) after the seq bits;
	// with constant 0xAB entropy the tail must be deterministic.
	tailA := a[len(a)-13:]
	b, _ := NewFromEntropy(bytes.NewReader(bytes.Repeat([]byte{0xAB}, 16)))
	if b[len(b)-13:] != tailA {
		t.Fatalf("fixed entropy produced non-deterministic tail: %q vs %q", tailA, b[len(b)-13:])
	}
}

func TestNewFromEntropyErrorOnNilReader(t *testing.T) {
	// A reader that returns 0 bytes / EOF must surface as an error, not a panic.
	if _, err := NewFromEntropy(bytes.NewReader(nil)); err == nil {
		t.Fatal("expected error from empty entropy source")
	}
}

func TestParseAndIsV7RejectGarbage(t *testing.T) {
	if _, err := Parse("not-a-uuid"); err == nil {
		t.Error("Parse accepted garbage")
	}
	if IsV7("11111111-1111-4111-8111-111111111111") {
		t.Error("IsV7 accepted a v4 uuid")
	}
	if IsV7("garbage") {
		t.Error("IsV7 accepted garbage")
	}
}
