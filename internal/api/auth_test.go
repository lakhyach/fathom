package api

import (
	"strings"
	"testing"
)

// Unit coverage for the pure startup guard cmd/fathom applies before binding
// (checklist gap 9). The guard is a foot-gun brake, not a security control,
// but its accept/refusal table is a documented contract and must not drift.
func TestLoopbackOnlyGuard(t *testing.T) {
	cases := map[string]struct {
		addr    string
		wantErr string // "" means must be accepted
	}{
		"ipv4 loopback":     {"127.0.0.1:8080", ""},
		"ipv6 loopback":     {"[::1]:8080", ""},
		"localhost name":    {"localhost:8080", ""},
		"public all v4":     {"0.0.0.0:8080", "refusing public bind"},
		"public all v6":     {"[::]:8080", "refusing public bind"},
		"bare host no port": {":8080", "refusing public bind"},
		"lan address":       {"192.168.1.10:8080", "refusing non-loopback bind"},
		"malformed":         {"nonsense", "bad listen address"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			err := LoopbackOnly(tc.addr)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("LoopbackOnly(%q) = %v, want accept", tc.addr, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("LoopbackOnly(%q) = %v, want error containing %q", tc.addr, err, tc.wantErr)
			}
			// The refusal must name the address (operator-actionable) but
			// never anything that looks like key material.
			if !strings.Contains(err.Error(), tc.addr) {
				t.Errorf("refusal should name the address: %v", err)
			}
		})
	}
}

// ParseKeys is pure too: the roles/labels/duplicate rules the RBAC ladder and
// the rate limiter both depend on are asserted here, without a database.
func TestParseKeysRules(t *testing.T) {
	if _, err := ParseKeys(""); err == nil {
		t.Fatal("empty spec must be rejected (the local-only boundary needs ≥1 key)")
	}
	k, err := ParseKeys("rd:reader:k-one1111111111111, op:operator:k-two2222222222222, adm:admin:k-three3333333333")
	if err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
	if got := len(k.byToken); got != 3 {
		t.Fatalf("loaded %d credentials, want 3", got)
	}
	c, ok := k.lookup("k-two2222222222222")
	if !ok || c.Role != RoleOperator || c.Label != "op" {
		t.Fatalf("lookup = (%q, %v, %v), want (op, operator, true)", c.Label, c.Role, ok)
	}
	if _, ok := k.lookup("k-not-configured"); ok {
		t.Error("unknown token must not resolve")
	}
	for _, bad := range []string{
		"op:operator",   // missing key material field
		"op:bard:k-xxx", // unknown role
		":reader:k-xxx", // empty label
		"op:operator:",  // empty key
	} {
		if _, err := ParseKeys(bad); err == nil {
			t.Errorf("spec %q should be rejected", bad)
		}
	}
	// Rejection errors must not echo key material (they are logged at startup).
	if _, err := ParseKeys("op:bard:k-supersecrettoken123"); err != nil && strings.Contains(err.Error(), "k-supersecrettoken123") {
		t.Errorf("ParseKeys error leaked key material: %v", err)
	}
	if _, err := ParseKeys("a:reader:same-key,b:operator:same-key"); err == nil {
		t.Error("duplicate key material across labels must be rejected (ambiguous identity)")
	}
}
