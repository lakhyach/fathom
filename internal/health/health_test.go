package health

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Healthz must answer 200 with NO database at all — the checklist D7
// invariant ("healthz never touches DB") is proven structurally: a Check
// built with a nil store still serves liveness, because the handler never
// dereferences it.
func TestHealthz_NeverTouchesDependencies(t *testing.T) {
	h := &Check{} // deliberately bypasses New(): nil store on purpose
	rec := httptest.NewRecorder()
	h.Healthz(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz code = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("body = %v, want status ok", body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q", ct)
	}
}

func TestNew_RejectsNilStore(t *testing.T) {
	if _, err := New(nil, time.Minute, nil); err == nil {
		t.Fatal("nil store must be refused at construction")
	}
}
