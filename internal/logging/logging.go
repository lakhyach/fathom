// Package logging provides the structured-logging foundation for Fathom.
//
// It builds a JSON slog logger at a configured level and wraps the handler with
// a redaction layer so that attributes whose keys resemble credentials (password,
// token, dsn, api key, authorization, private key, secret) never reach the log
// sink, regardless of what a caller accidentally logs. This complements the
// config.Secret type: Secret redacts known values at the type level; RedactHandler
// redacts by key name at the sink level.
package logging

import (
	"context"
	"io"
	"log/slog"
	"strings"
)

// redactedKeys are normalised (lowercased) attribute keys whose values are
// replaced with a fixed marker before the record is written.
var redactedKeys = map[string]bool{
	"password":      true,
	"passwd":        true,
	"secret":        true,
	"token":         true,
	"authorization": true,
	"api_key":       true,
	"apikey":        true,
	"access_key":    true,
	"private_key":   true,
	"dsn":           true,
	"credential":    true,
	"database_url":  true,
}

// RedactMarker is written in place of any value under a sensitive key.
const RedactMarker = "[REDACTED]"

// redactHandler wraps a slog.Handler and scrubs values of sensitive keys in
// both top-level attributes and groups.
type redactHandler struct {
	next slog.Handler
}

// NewRedactHandler wraps next with key-based redaction.
func NewRedactHandler(next slog.Handler) slog.Handler {
	return &redactHandler{next: next}
}

func (h *redactHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *redactHandler) Handle(ctx context.Context, r slog.Record) error {
	if hasSensitive(r) {
		filtered := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
		r.Attrs(func(a slog.Attr) bool {
			filtered.AddAttrs(h.scrub(a))
			return true
		})
		return h.next.Handle(ctx, filtered)
	}
	return h.next.Handle(ctx, r)
}

func (h *redactHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	scrubbed := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		scrubbed = append(scrubbed, h.scrub(a))
	}
	return &redactHandler{next: h.next.WithAttrs(scrubbed)}
}

func (h *redactHandler) WithGroup(name string) slog.Handler {
	return &redactHandler{next: h.next.WithGroup(name)}
}

func (h *redactHandler) scrub(a slog.Attr) slog.Attr {
	if isSensitive(a.Key) {
		return slog.String(a.Key, RedactMarker)
	}
	if a.Value.Kind() == slog.KindGroup {
		group := a.Value.Group()
		out := make([]slog.Attr, 0, len(group))
		for _, ga := range group {
			out = append(out, h.scrub(ga))
		}
		return slog.Group(a.Key, toAnySlice(out)...)
	}
	return a
}

func hasSensitive(r slog.Record) bool {
	found := false
	r.Attrs(func(a slog.Attr) bool {
		if isSensitive(a.Key) || (a.Value.Kind() == slog.KindGroup && groupHasSensitive(a.Value.Group())) {
			found = true
			return false
		}
		return true
	})
	return found
}

func groupHasSensitive(attrs []slog.Attr) bool {
	for _, a := range attrs {
		if isSensitive(a.Key) {
			return true
		}
		if a.Value.Kind() == slog.KindGroup && groupHasSensitive(a.Value.Group()) {
			return true
		}
	}
	return false
}

func toAnySlice(attrs []slog.Attr) []any {
	out := make([]any, 0, len(attrs)*2)
	for _, a := range attrs {
		out = append(out, a)
	}
	return out
}

func isSensitive(key string) bool {
	return redactedKeys[strings.ToLower(key)]
}

// parseLevel maps a configuration level string to a slog level.
func parseLevel(s string) (slog.Level, error) {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug, nil
	case "", "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, &levelError{name: s}
	}
}

type levelError struct{ name string }

func (e *levelError) Error() string { return "unknown log level: " + e.name }

// New builds a JSON logger writing to w at the given level, with key-based
// redaction applied.
func New(w io.Writer, level string) (*slog.Logger, error) {
	lvl, err := parseLevel(level)
	if err != nil {
		return nil, err
	}
	handler := NewRedactHandler(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lvl}))
	return slog.New(handler), nil
}

// WithWorkflow returns a logger carrying a workflow correlation field. It adds
// structure only; it never emits an event on its own.
func WithWorkflow(l *slog.Logger, workflowID string) *slog.Logger {
	return l.With("workflow_id", workflowID)
}
