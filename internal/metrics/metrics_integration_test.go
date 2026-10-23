//go:build integration

package metrics

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/Lakhyajit-96/fathom/internal/engine"
	"github.com/Lakhyajit-96/fathom/internal/health"
	"github.com/Lakhyajit-96/fathom/internal/id"
	postgres "github.com/Lakhyajit-96/fathom/internal/store/postgres"
)

// Checklist D7 / M-T1: every wired series must move under real operations.
// This test drives the actual engine, ingress, relay ledger and DLQ against
// real PostgreSQL and scrapes the collector between steps — no fixture
// numbers, only observations of things that just happened.

var store *postgres.Store

func TestMain(m *testing.M) {
	dsn := os.Getenv("FATHOM_TEST_DATABASE_URL")
	if dsn == "" {
		fmt.Println("integration: FATHOM_TEST_DATABASE_URL unset — skipping metrics tests")
		os.Exit(0)
	}
	ctx := context.Background()
	st, err := postgres.Open(ctx, dsn)
	if err != nil {
		fmt.Println("integration: open:", err)
		os.Exit(1)
	}
	if err := st.Migrate(ctx); err != nil {
		fmt.Println("integration: migrate:", err)
		os.Exit(1)
	}
	store = st
	code := m.Run()
	store.Close()
	os.Exit(code)
}

func resetDB(t *testing.T) {
	t.Helper()
	_, err := store.Pool().Exec(context.Background(),
		`TRUNCATE attempt, step, processed_events, inbound_event, outbox, api_idempotency, dead_letter, audit_event, workflow,
		         operator_action, relay_checkpoint, workflow_definition CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// gather scrapes through the real registry and indexes one series value.
func metricValue(t *testing.T, reg *prometheus.Registry, name string, labels map[string]string) (float64, bool) {
	t.Helper()
	fams, err := reg.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range fams {
		if fam.GetName() != name {
			continue
		}
		for _, m := range fam.GetMetric() {
			ok := true
			for k, v := range labels {
				found := false
				for _, lp := range m.GetLabel() {
					if lp.GetName() == k && lp.GetValue() == v {
						found = true
						break
					}
				}
				if !found {
					ok = false
					break
				}
			}
			if ok {
				if g := m.GetGauge(); g != nil {
					return g.GetValue(), true
				}
				if c := m.GetCounter(); c != nil {
					return c.GetValue(), true
				}
			}
		}
	}
	return 0, false
}

func mustValue(t *testing.T, reg *prometheus.Registry, name string, labels map[string]string) float64 {
	t.Helper()
	v, ok := metricValue(t, reg, name, labels)
	if !ok {
		t.Fatalf("series %s%v absent after real operations", name, labels)
	}
	return v
}

func createWF(t *testing.T) string {
	t.Helper()
	out, err := store.CreateWorkflow(context.Background(), postgres.CreateParams{
		IdempotencyKey: id.New(),
		DefName:        "mtest", DefVersion: 1,
		DefSnapshot: json.RawMessage(`{"note":"metrics test"}`),
		BusinessKey: "bk:" + id.New(),
		Input:       json.RawMessage(`{"n":1}`),
		Deadline:    time.Now().UTC().Add(time.Hour),
		Steps:       []engine.StepSpec{{Type: "task-a", MaxAttempts: 1}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return out.Workflow.ID
}

func TestMetrics_SeriesMoveOnRealOperations(t *testing.T) {
	resetDB(t)
	reg := prometheus.NewRegistry()
	reg.MustRegister(NewCollector(store, nil))

	// --- QUEUED workflow exists ------------------------------------------------
	wfID := createWF(t)
	if v := mustValue(t, reg, "fathom_workflows_total", map[string]string{"def_name": "mtest", "state": "QUEUED"}); v != 1 {
		t.Fatalf("workflows QUEUED = %v, want 1", v)
	}
	if v := mustValue(t, reg, "fathom_outbox_unpublished_count", nil); v != 1 {
		t.Fatalf("outbox pending = %v, want 1 (W1 emits the first command)", v)
	}
	if v := mustValue(t, reg, "fathom_oldest_open_workflow_age_seconds", nil); v < 0 {
		t.Fatalf("oldest open age = %v", v)
	}

	// --- start it: a transition lands in the audit-derived counter -------------
	loaded, err := store.LoadWorkflow(context.Background(), wfID)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if _, err := store.Start(context.Background(), wfID, loaded.Version); err != nil {
		t.Fatalf("start: %v", err)
	}
	// A transition landed in the audit-derived counter (labels: from,to,
	// reason_code — we match on the edge, the reason is the machine's).
	if _, ok := metricValue(t, reg, "fathom_workflow_transitions_total",
		map[string]string{"from": "QUEUED", "to": "RUNNING"}); !ok {
		t.Fatal("QUEUED->RUNNING transition series absent after a real Start")
	}

	// --- a worker lease is visible ---------------------------------------------
	claim, got, err := store.ClaimStep(context.Background(), "mtest-worker", 30*time.Second)
	if err != nil || !got {
		t.Fatalf("claim: got=%v err=%v", got, err)
	}
	if v := mustValue(t, reg, "fathom_worker_leases_held", nil); v != 1 {
		t.Fatalf("leases held = %v, want 1", v)
	}

	// --- an inbound result classifies (APPLIED) and completes the workflow ------
	wf, err := store.LoadWorkflow(context.Background(), wfID)
	if err != nil {
		t.Fatalf("load 2: %v", err)
	}
	ev := engine.ResultEvent{EventID: id.New(), WorkflowID: wfID, StepType: claim.StepType,
		Attempt: claim.Attempt, Outcome: engine.OutcomeSucceeded, ExpectedVersion: wf.Version}
	class, err := store.ApplyResult(context.Background(), ev, json.RawMessage(`{}`))
	if err != nil || class != engine.ClassApplied {
		t.Fatalf("apply: class=%s err=%v", class, err)
	}
	if v := mustValue(t, reg, "fathom_events_classified_total",
		map[string]string{"classification": "APPLIED"}); v != 1 {
		t.Fatalf("classified APPLIED = %v, want 1", v)
	}
	if v := mustValue(t, reg, "fathom_workflows_total", map[string]string{"def_name": "mtest", "state": "COMPLETED"}); v != 1 {
		t.Fatalf("COMPLETED = %v, want 1", v)
	}
	// No open workflows remain: the gate metric returns to baseline honestly.
	if v := mustValue(t, reg, "fathom_oldest_open_workflow_age_seconds", nil); v != 0 {
		t.Fatalf("oldest open age = %v with zero open workflows", v)
	}

	// --- relay ledger: ack moves the checkpoint series --------------------------
	rows, err := store.ClaimOutboxBatch(context.Background(), "mtest-relay", 10, 30*time.Second)
	if err != nil || len(rows) != 1 {
		t.Fatalf("claim outbox: rows=%d err=%v", len(rows), err)
	}
	if _, err := store.AckPublished(context.Background(), "mtest-relay", []int64{rows[0].Seq}); err != nil {
		t.Fatalf("ack: %v", err)
	}
	if v := mustValue(t, reg, "fathom_relay_unacked_rows", map[string]string{"relay": "mtest-relay"}); v != 0 {
		t.Fatalf("relay lag rows = %v after acking the only row", v)
	}
	if v := mustValue(t, reg, "fathom_relay_publish_lag_seconds", map[string]string{"relay": "mtest-relay"}); v < 0 {
		t.Fatalf("relay lag seconds = %v", v)
	}
	if v := mustValue(t, reg, "fathom_outbox_unpublished_count", nil); v != 0 {
		t.Fatalf("outbox pending = %v after full delivery", v)
	}

	// --- delivery exhaustion files a RETRY_EXHAUSTED DLQ, visible by class -----
	secondID := createWF(t)
	_ = secondID
	rows, err = store.ClaimOutboxBatch(context.Background(), "dead-relay", 10, 30*time.Second)
	if err != nil || len(rows) != 1 {
		t.Fatalf("claim for failure: rows=%d err=%v", len(rows), err)
	}
	exhausted, err := store.PublishFailed(context.Background(), "dead-relay", rows[0].Seq, 1, "broker gone")
	if err != nil || !exhausted {
		t.Fatalf("publish failed: exhausted=%v err=%v", exhausted, err)
	}
	if v := mustValue(t, reg, "fathom_dlq_depth", map[string]string{"class": "RETRY_EXHAUSTED"}); v != 1 {
		t.Fatalf("dlq depth = %v, want 1", v)
	}
	if v := mustValue(t, reg, "fathom_dlq_oldest_age_seconds", nil); v < 0 {
		t.Fatalf("dlq oldest age = %v", v)
	}
	// The dead-lettered row is NOT pending (it awaits operator work, not relay work).
	if v := mustValue(t, reg, "fathom_outbox_unpublished_count", nil); v != 0 {
		t.Fatalf("pending after dead-lettering = %v, want 0", v)
	}
}

func TestReadyz_GatesOnRealState(t *testing.T) {
	resetDB(t)
	hc, err := health.New(store, time.Minute, nil)
	if err != nil {
		t.Fatalf("health new: %v", err)
	}
	ready := func() int {
		rec := httptest.NewRecorder()
		hc.Readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		return rec.Code
	}

	if code := ready(); code != http.StatusOK {
		t.Fatalf("empty system readyz = %d, want 200", code)
	}

	// A fresh backlog is ready...
	createWF(t)
	if code := ready(); code != http.StatusOK {
		t.Fatalf("fresh backlog readyz = %d, want 200", code)
	}
	// ...but a stale one (older than the threshold) gates load off.
	if _, err := store.Pool().Exec(context.Background(),
		`UPDATE outbox SET created_at = now() - interval '2 hours' WHERE published_at IS NULL`); err != nil {
		t.Fatalf("age backlog: %v", err)
	}
	rec := httptest.NewRecorder()
	hc.Readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("stale backlog readyz = %d, want 503", rec.Code)
	}
	if body := rec.Body.String(); !json.Valid([]byte(body)) || !strings.Contains(body, "relay_lag") {
		t.Fatalf("readyz body = %s, want reason relay_lag", body)
	}

	// Unreachable database: 503 db_unavailable, measured on a closed store.
	store2, err := postgres.Open(context.Background(), dsn())
	if err != nil {
		t.Fatalf("open second: %v", err)
	}
	store2.Close()
	hc2, err := health.New(store2, time.Minute, nil)
	if err != nil {
		t.Fatalf("health new 2: %v", err)
	}
	rec = httptest.NewRecorder()
	hc2.Readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "db_unavailable") {
		t.Fatalf("closed-store readyz = %d %s", rec.Code, rec.Body.String())
	}
}

func dsn() string { return os.Getenv("FATHOM_TEST_DATABASE_URL") }
