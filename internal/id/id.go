// Package id is Fathom's identifier policy.
//
// The data contract (docs/DATA_AND_API_CONTRACTS.md) requires time-ordered,
// globally unique identifiers for workflows, steps, events, and inbox keys.
// Go's standard library has no RFC 9562 UUID facility (v7 was added by that
// spec), so this package
// wraps google/uuid and centralises the decisions: always UUID version 7,
// rendered in canonical lowercase hyphenated text. UUIDv7 leads with a 48-bit
// Unix-ms timestamp, so identifiers sort by creation time — a property later
// phases rely on for ordered primary keys and cursor paging.
//
// A single narrow seam (NewFromEntropy) lets tests inject deterministic
// entropy; production callers use New.
package id

import (
	"io"

	"github.com/google/uuid"
)

// New returns a new time-ordered (v7) identifier in canonical text form.
// It panics only if the system entropy source fails, which is unrecoverable.
func New() string {
	u, err := uuid.NewV7()
	if err != nil {
		// Entropy failure is not a condition callers can meaningfully handle;
		// surfacing it as a panic at the top of the identifier policy is the
		// documented contract (see package docs).
		panic("id: entropy source failure: " + err.Error())
	}
	return u.String()
}

// NewFromEntropy returns a v7 identifier using r as the random-bit source,
// enabling deterministic tests. The timestamp still comes from the clock.
func NewFromEntropy(r io.Reader) (string, error) {
	u, err := uuid.NewV7FromReader(r)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// Parse validates and normalises an identifier string.
func Parse(s string) (string, error) {
	u, err := uuid.Parse(s)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// IsV7 reports whether s is a well-formed UUID whose version nibble is 7.
func IsV7(s string) bool {
	u, err := uuid.Parse(s)
	if err != nil {
		return false
	}
	return u.Version() == 7
}
