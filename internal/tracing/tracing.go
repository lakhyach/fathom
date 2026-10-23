// Package tracing implements the contract-level W3C trace context Fathom
// propagates (PRODUCT REQ-OP-6, DATA §E): a `traceparent` header value is
// minted at each durable transition and carried unchanged into the outbox
// envelope, so every event and audit row of one workflow run shares a trace
// id. It deliberately does NOT depend on the OpenTelemetry SDK: no collector
// runs in this phase, and per the Phase-5 brief (§8) telemetry must not be
// fabricated ahead of the operations that produce it. The header format is
// exactly the W3C one, so an OTel-enabled deployment can adopt these ids
// without touching a call site.
package tracing

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

// version is the only traceparent version this code mints ("00"), per the
// W3C Trace Context spec.
const version = "00"

// NewTraceparent returns a fresh trace context: "00-<32hex trace>-<16hex span>-01"
// (sampled flag on). Trace ids come from crypto/rand; a failure there is a
// system-scope failure and panics rather than silently producing an invalid
// header — the same policy as jsonb marshalling in the store.
func NewTraceparent() string {
	return "00-" + hexString(16) + "-" + hexString(8) + "-01"
}

// TraceID extracts the 32-hex trace id from a traceparent value, or "" when
// the value is absent or malformed. It is intentionally tolerant: propagation
// must never fail a request/transition over a bad header.
func TraceID(traceparent string) string {
	// "00-<trace>-<span>-<flags>"
	parts := strings.Split(traceparent, "-")
	if len(parts) != 4 || len(parts[1]) != 32 {
		return ""
	}
	if _, err := hex.DecodeString(parts[1]); err != nil {
		return ""
	}
	return parts[1]
}

// FromTraceID wraps an existing trace id (carried in an inbound envelope)
// into a valid traceparent with a fresh span id, continuing the caller's
// trace instead of starting a new one. A malformed/empty id mints fresh.
func FromTraceID(traceID string) string {
	if len(traceID) != 32 {
		return NewTraceparent()
	}
	if _, err := hex.DecodeString(traceID); err != nil {
		return NewTraceparent()
	}
	return version + "-" + traceID + "-" + hexString(8) + "-01"
}

func hexString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("tracing: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}
