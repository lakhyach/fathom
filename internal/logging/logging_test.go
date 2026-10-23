package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func newTestLogger(t *testing.T, buf *bytes.Buffer, level string) *slog.Logger {
	t.Helper()
	l, err := New(buf, level)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return l
}

func TestRedactsSensitiveKeyAtLogTime(t *testing.T) {
	var buf bytes.Buffer
	l := newTestLogger(t, &buf, "info")
	l.Info("login", "user", "alice", "password", "hunter2supersecret")
	out := buf.String()
	if strings.Contains(out, "hunter2supersecret") {
		t.Fatalf("password value leaked to sink: %s", out)
	}
	if !strings.Contains(out, RedactMarker) {
		t.Fatalf("expected redaction marker, got %s", out)
	}
	// Non-sensitive sibling must survive.
	if !strings.Contains(out, "alice") {
		t.Fatalf("non-sensitive attr dropped: %s", out)
	}
}

func TestRedactsCaseInsensitiveAndGrouped(t *testing.T) {
	var buf bytes.Buffer
	l := newTestLogger(t, &buf, "info")
	l.Info("db", slog.Group("conn", slog.String("Password", "s3cretvalue"), slog.String("host", "127.0.0.1")))
	out := buf.String()
	if strings.Contains(out, "s3cretvalue") {
		t.Fatalf("grouped Password leaked (case-insensitive): %s", out)
	}
	if !strings.Contains(out, "127.0.0.1") {
		t.Fatalf("grouped host attr dropped: %s", out)
	}
}

func TestRedactsViaWithAttrs(t *testing.T) {
	var buf bytes.Buffer
	l := newTestLogger(t, &buf, "info").With("token", "abcdef12345")
	l.Info("request")
	out := buf.String()
	if strings.Contains(out, "abcdef12345") {
		t.Fatalf("bound token attr leaked: %s", out)
	}
	if !strings.Contains(out, RedactMarker) {
		t.Fatalf("expected redaction for bound attr: %s", out)
	}
}

func TestLevelFiltering(t *testing.T) {
	var buf bytes.Buffer
	l := newTestLogger(t, &buf, "warn")
	l.Debug("debug-hidden")
	l.Info("info-hidden")
	l.Warn("warn-shown")
	out := buf.String()
	if strings.Contains(out, "debug-hidden") || strings.Contains(out, "info-hidden") {
		t.Fatalf("records below warn were emitted: %s", out)
	}
	if !strings.Contains(out, "warn-shown") {
		t.Fatalf("warn record suppressed: %s", out)
	}
}

func TestUnknownLevelIsError(t *testing.T) {
	var buf bytes.Buffer
	if _, err := New(&buf, "verbose"); err == nil {
		t.Fatal("expected error for unknown level")
	}
}

func TestOutputIsValidJSONWithMessage(t *testing.T) {
	var buf bytes.Buffer
	l := newTestLogger(t, &buf, "info")
	l.Info("hello", "workflow_id", "wf-1")
	var rec map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &rec); err != nil {
		t.Fatalf("output not JSON: %v (%s)", err, buf.String())
	}
	if rec["msg"] != "hello" || rec["workflow_id"] != "wf-1" {
		t.Fatalf("unexpected record: %+v", rec)
	}
}

func TestWithWorkflowAddsField(t *testing.T) {
	var buf bytes.Buffer
	l := newTestLogger(t, &buf, "info")
	WithWorkflow(l, "wf-42").Info("tick")
	if !strings.Contains(buf.String(), "wf-42") {
		t.Fatalf("WithWorkflow did not add correlation id: %s", buf.String())
	}
}
