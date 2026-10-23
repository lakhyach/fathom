//go:build integration

package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Lakhyajit-96/fathom/internal/engine"
	"github.com/Lakhyajit-96/fathom/internal/id"
)

// T-INT tier (RELIABILITY_AND_FAILURE_TEST_PLAN §1). These run only under the
// `integration` build tag and only when FATHOM_TEST_DATABASE_URL points at an
// ISOLATED, THROWAWAY PostgreSQL 17 database — never a user's data (brief §8).
// The validation script starts postgres:17.11-alpine, exports the DSN, and runs
// `go test -tags integration ./internal/store/...`.

var testStore *Store

func TestMain(m *testing.M) {
	dsn := os.Getenv("FATHOM_TEST_DATABASE_URL")
	if dsn == "" {
		fmt.Println("integration: FATHOM_TEST_DATABASE_URL unset — skipping all T-INT tests")
		os.Exit(0)
	}
	ctx := context.Background()
	st, err := Open(ctx, dsn)
	if err != nil {
		fmt.Println("integration: open:", err)
		os.Exit(1)
	}
	if err := st.Migrate(ctx); err != nil {
		fmt.Println("integration: migrate:", err)
		st.Close()
		os.Exit(1)
	}
	testStore = st
	code := m.Run()
	testStore.Close()
	os.Exit(code)
}

func ctxc() context.Context { return context.Background() }

// reset truncates every durable table. TRUNCATE (not DELETE) is used because the
// append-only triggers fire on UPDATE/DELETE, not TRUNCATE.
func reset(t *testing.T) {
	t.Helper()
	_, err := testStore.Pool().Exec(ctxc(),
		`TRUNCATE attempt, step, processed_events, inbound_event, outbox, api_idempotency, dead_letter, audit_event, workflow CASCADE`)
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
}

func twoStepParams() CreateParams {
	return CreateParams{
		IdempotencyKey: id.New(),
		DefName:        "room-reservation",
		DefVersion:     1,
		DefSnapshot:    json.RawMessage(`{"steps":["reserve-room","charge-payment"]}`),
		BusinessKey:    "room:" + id.New(),
		Input:          json.RawMessage(`{"guest":"g1"}`),
		Deadline:       time.Now().UTC().Add(15 * time.Minute),
		Steps: []engine.StepSpec{
			{Type: "reserve-room", MaxAttempts: 3, Compensable: true},
			{Type: "charge-payment", MaxAttempts: 3, Compensable: true},
		},
	}
}

// seedRunning creates + starts a two-step workflow, returning the RUNNING
// snapshot (version already advanced past QUEUED).
func seedRunning(t *testing.T) engine.Workflow {
	t.Helper()
	out, err := testStore.CreateWorkflow(ctxc(), twoStepParams())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wf, err := testStore.Start(ctxc(), out.Workflow.ID, out.Workflow.Version)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	return wf
}

func successEvent(wfID, step string, attempt int, version int64) engine.ResultEvent {
	return engine.ResultEvent{EventID: id.New(), WorkflowID: wfID, StepType: step,
		Attempt: attempt, Outcome: engine.OutcomeSucceeded, ExpectedVersion: version}
}

func failEvent(wfID, step string, attempt int, class engine.ErrorClass, version int64) engine.ResultEvent {
	return engine.ResultEvent{EventID: id.New(), WorkflowID: wfID, StepType: step,
		Attempt: attempt, Outcome: engine.OutcomeFailed, ErrorClass: class, ExpectedVersion: version}
}

func apply(t *testing.T, ev engine.ResultEvent) engine.Classification {
	t.Helper()
	class, err := testStore.ApplyResult(ctxc(), ev, json.RawMessage(`{"data":{"outcome":"x"}}`))
	if err != nil {
		t.Fatalf("apply %s: %v", ev.StepType, err)
	}
	return class
}

func count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := testStore.Pool().QueryRow(ctxc(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count (%s): %v", query, err)
	}
	return n
}

func loadState(t *testing.T, wfID string) engine.Workflow {
	t.Helper()
	wf, err := testStore.LoadWorkflow(ctxc(), wfID)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return wf
}

// driveToCompleted runs the happy path through the durable store.
func driveToCompleted(t *testing.T) engine.Workflow {
	t.Helper()
	wf := seedRunning(t)
	wf = applyThenLoad(t, wf.ID, successEvent(wf.ID, "reserve-room", 1, wf.Version))
	apply(t, successEvent(wf.ID, "charge-payment", 1, wf.Version))
	return loadState(t, wf.ID)
}

func applyThenLoad(t *testing.T, wfID string, ev engine.ResultEvent) engine.Workflow {
	t.Helper()
	apply(t, ev)
	return loadState(t, wfID)
}

func TestStore_MigrateFreshAndVersion(t *testing.T) {
	reset(t)
	v, dirty, err := testStore.SchemaVersion(ctxc())
	if err != nil {
		t.Fatal(err)
	}
	if dirty {
		t.Fatal("schema is dirty after fresh migrate")
	}
	if v != 1 {
		t.Fatalf("schema version = %d, want 1", v)
	}
	// A second Migrate must be a safe no-op (reproducible apply).
	if err := testStore.Migrate(ctxc()); err != nil {
		t.Fatalf("re-migrate: %v", err)
	}
}

func TestStore_CreateIsAtomic(t *testing.T) {
	reset(t)
	out, err := testStore.CreateWorkflow(ctxc(), twoStepParams())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wfID := out.Workflow.ID
	if count(t, `SELECT count(*) FROM workflow WHERE id=$1 AND state='QUEUED' AND version=1`, wfID) != 1 {
		t.Fatal("workflow row (QUEUED,v1) missing")
	}
	if count(t, `SELECT count(*) FROM step WHERE workflow_id=$1 AND state='PENDING'`, wfID) != 2 {
		t.Fatal("expected 2 PENDING step rows")
	}
	if count(t, `SELECT count(*) FROM audit_event WHERE workflow_id=$1 AND reason_code='WORKFLOW_CREATED'`, wfID) != 1 {
		t.Fatal("creation audit missing")
	}
	if count(t, `SELECT count(*) FROM outbox WHERE workflow_id=$1`, wfID) < 1 {
		t.Fatal("first-step command intent missing from outbox")
	}
}

func TestStore_TransitionAtomicity_CommitTogether(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	ev := successEvent(wf.ID, "reserve-room", 1, wf.Version)
	if got := apply(t, ev); got != engine.ClassApplied {
		t.Fatalf("class = %s, want APPLIED", got)
	}
	// All artifacts of the one transition committed together:
	if count(t, `SELECT count(*) FROM step WHERE workflow_id=$1 AND step_type='reserve-room' AND state='SUCCEEDED'`, wf.ID) != 1 {
		t.Fatal("step0 not SUCCEEDED")
	}
	if count(t, `SELECT count(*) FROM step WHERE workflow_id=$1 AND step_type='charge-payment' AND state='ISSUED'`, wf.ID) != 1 {
		t.Fatal("step1 not ISSUED")
	}
	if count(t, `SELECT count(*) FROM processed_events WHERE event_id=$1`, ev.EventID) != 1 {
		t.Fatal("dedup ledger row missing")
	}
	if count(t, `SELECT count(*) FROM outbox WHERE workflow_id=$1 AND step_type='charge-payment'`, wf.ID) != 1 {
		t.Fatal("next-step command not in outbox")
	}
}

// TestStore_ConcurrentWritersSameVersion proves at most one of two writers using
// the same expected version commits (ADR-009, DS-4).
func TestStore_ConcurrentWritersSameVersion(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	v := wf.Version

	var applied, losers int32
	var wg sync.WaitGroup
	run := func() {
		defer wg.Done()
		ev := engine.ResultEvent{EventID: id.New(), WorkflowID: wf.ID, StepType: "reserve-room",
			Attempt: 1, Outcome: engine.OutcomeSucceeded, ExpectedVersion: v}
		class, err := testStore.ApplyResult(ctxc(), ev, json.RawMessage(`{}`))
		switch {
		case err != nil:
			// A typed concurrency conflict is one valid "losing writer" outcome.
			var ce ConflictError
			if !errors.As(err, &ce) {
				t.Errorf("unexpected error: %v", err)
			}
			atomic.AddInt32(&losers, 1)
		case class == engine.ClassApplied:
			atomic.AddInt32(&applied, 1)
		default:
			// STALE/other non-APPLIED: the second writer was serialised behind the
			// first and made no mutation — also a valid loser under the version guard.
			atomic.AddInt32(&losers, 1)
		}
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go run()
	}
	wg.Wait()

	if applied != 1 {
		t.Fatalf("APPLIED writers = %d, want exactly 1", applied)
	}
	if losers != 1 {
		t.Fatalf("non-mutating writers = %d, want exactly 1", losers)
	}
	// Version advanced by exactly one, and only one next-step command issued.
	cur := loadState(t, wf.ID)
	if cur.Version != v+1 {
		t.Fatalf("version = %d, want %d", cur.Version, v+1)
	}
	if n := count(t, `SELECT count(*) FROM outbox WHERE workflow_id=$1 AND step_type='charge-payment'`, wf.ID); n != 1 {
		t.Fatalf("next-step commands = %d, want 1", n)
	}
}

// TestStore_ConcurrentCreateSameIdempotencyKey proves exactly one workflow is
// created for a key hammered concurrently (DATA §D, ADR-011, DS-8).
func TestStore_ConcurrentCreateSameIdempotencyKey(t *testing.T) {
	reset(t)
	const n = 6
	key := id.New()
	bk := "room:" + id.New()
	base := twoStepParams()
	base.IdempotencyKey = key
	base.BusinessKey = bk

	var created, replayed int32
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := testStore.CreateWorkflow(ctxc(), base)
			if err != nil {
				errs <- err
				return
			}
			if out.Replayed {
				atomic.AddInt32(&replayed, 1)
			} else {
				atomic.AddInt32(&created, 1)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent create error: %v", err)
	}
	if created != 1 {
		t.Fatalf("creations = %d, want exactly 1", created)
	}
	if replayed != n-1 {
		t.Fatalf("replays = %d, want %d", replayed, n-1)
	}
	if c := count(t, `SELECT count(*) FROM workflow WHERE business_key=$1`, bk); c != 1 {
		t.Fatalf("workflows for business key = %d, want 1", c)
	}
}

func TestStore_IdempotencyKeyReuseDifferentPayload(t *testing.T) {
	reset(t)
	key := id.New()
	p1 := twoStepParams()
	p1.IdempotencyKey = key
	if _, err := testStore.CreateWorkflow(ctxc(), p1); err != nil {
		t.Fatal(err)
	}
	p2 := twoStepParams()
	p2.IdempotencyKey = key
	p2.Input = json.RawMessage(`{"guest":"DIFFERENT"}`) // same key, different body
	_, err := testStore.CreateWorkflow(ctxc(), p2)
	var ice IdempotencyConflictError
	if !errors.As(err, &ice) {
		t.Fatalf("want IdempotencyConflictError, got %v", err)
	}
	// Replay with the ORIGINAL body returns the same durable outcome, no new row.
	replay, err := testStore.CreateWorkflow(ctxc(), p1)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !replay.Replayed {
		t.Fatal("expected Replayed=true for matching key+payload")
	}
}

// TestStore_DedupRepeatedDelivery proves a byte-identical redelivery is a
// no-op DUPLICATE: no version change, no second command (SM §5, DATA §D).
func TestStore_DedupRepeatedDelivery(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	ev := successEvent(wf.ID, "reserve-room", 1, wf.Version)
	if got := apply(t, ev); got != engine.ClassApplied {
		t.Fatalf("first = %s", got)
	}
	vAfter := loadState(t, wf.ID).Version

	// Re-deliver the exact same event id.
	second := ev
	class, err := testStore.ApplyResult(ctxc(), second, json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("redeliver: %v", err)
	}
	if class != engine.ClassDuplicate {
		t.Fatalf("redeliver class = %s, want DUPLICATE", class)
	}
	if loadState(t, wf.ID).Version != vAfter {
		t.Fatal("duplicate mutated the workflow version")
	}
	if n := count(t, `SELECT count(*) FROM outbox WHERE workflow_id=$1 AND step_type='charge-payment'`, wf.ID); n != 1 {
		t.Fatalf("duplicate produced a second command (outbox rows = %d)", n)
	}
}

// TestStore_RollbackOnMidwayFailure proves the durable boundary is all-or-nothing:
// a failure after the state change rolls the whole transition back.
func TestStore_RollbackOnMidwayFailure(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	before := loadState(t, wf.ID)
	auditBefore := count(t, `SELECT count(*) FROM audit_event WHERE workflow_id=$1`, wf.ID)

	// Mirror the store's transaction body but abort after the guarded update by
	// tripping a foreign-key (processed_events -> inbound_event) violation.
	tx, err := testStore.Pool().Begin(ctxc())
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctxc(),
		`UPDATE workflow SET version = version + 1 WHERE id = $1 AND version = $2`, wf.ID, before.Version)
	if err != nil {
		t.Fatalf("update in tx: %v", err)
	}
	_, err = tx.Exec(ctxc(),
		`INSERT INTO audit_event (workflow_id, kind, reason_code, detail) VALUES ($1,'TRANSITION','X','{}'::jsonb)`, wf.ID)
	if err != nil {
		t.Fatalf("audit in tx: %v", err)
	}
	// Deliberate failure: a dedup row for an event_id that has no inbound_event.
	_, err = tx.Exec(ctxc(),
		`INSERT INTO processed_events (event_id, workflow_id) VALUES ($1, $2)`, id.New(), wf.ID)
	if err == nil {
		t.Fatal("expected FK violation, got none")
	}
	if rerr := tx.Rollback(ctxc()); rerr != nil {
		t.Fatalf("rollback: %v", rerr)
	}

	after := loadState(t, wf.ID)
	if after.Version != before.Version {
		t.Fatalf("version changed after rollback: %d -> %d", before.Version, after.Version)
	}
	if count(t, `SELECT count(*) FROM audit_event WHERE workflow_id=$1`, wf.ID) != auditBefore {
		t.Fatal("audit row persisted despite rollback")
	}
}

// TestStore_ProcessRestart proves the durable state reloads after a process
// restart (a fresh pool over the same database) and execution continues.
func TestStore_ProcessRestart(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	apply(t, successEvent(wf.ID, "reserve-room", 1, wf.Version))

	// Simulate restart: open a brand-new Store against the same DSN.
	reopened, err := Open(ctxc(), os.Getenv("FATHOM_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.Migrate(ctxc()); err != nil { // no-op, already at v1
		t.Fatal(err)
	}
	reloaded, err := reopened.LoadWorkflow(ctxc(), wf.ID)
	if err != nil {
		t.Fatalf("load after restart: %v", err)
	}
	if reloaded.State != engine.StateRunning {
		t.Fatalf("state after restart = %s, want RUNNING", reloaded.State)
	}
	if reloaded.Steps[0].State != engine.StepSucceeded || reloaded.Steps[1].State != engine.StepIssued {
		t.Fatalf("steps not restored: %+v", reloaded.Steps)
	}
	// Continue to completion across the restarted store.
	ev := successEvent(reloaded.ID, "charge-payment", 1, reloaded.Version)
	if _, err := reopened.ApplyResult(ctxc(), ev, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	final, _ := reopened.LoadWorkflow(ctxc(), wf.ID)
	if final.State != engine.StateCompleted {
		t.Fatalf("final = %s, want COMPLETED", final.State)
	}
}

func TestStore_AppendOnlyAuditTrigger(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	_, err := testStore.Pool().Exec(ctxc(),
		`UPDATE audit_event SET reason_code='TAMPERED' WHERE workflow_id=$1`, wf.ID)
	if err == nil {
		t.Fatal("audit_event UPDATE should be forbidden by the append-only trigger")
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "P0001" {
		t.Fatalf("want raised exception from trigger, got %v", err)
	}
	if _, err := testStore.Pool().Exec(ctxc(),
		`DELETE FROM audit_event WHERE workflow_id=$1`, wf.ID); err == nil {
		t.Fatal("audit_event DELETE should be forbidden")
	}
}

// TestStore_SchemaConstraints proves the critical invariants are enforced by the
// database itself, not only by the application.
func TestStore_SchemaConstraints(t *testing.T) {
	reset(t)
	wf := seedRunning(t)

	// (a) step primary key uniqueness.
	if _, err := testStore.Pool().Exec(ctxc(),
		`INSERT INTO step (workflow_id, step_type, position, state, max_attempts) VALUES ($1,'reserve-room',0,'PENDING',1)`,
		wf.ID); !isUniquePG(err) {
		t.Fatalf("expected 23505 on duplicate step, got %v", err)
	}
	// (b) attempt -> step foreign key.
	if _, err := testStore.Pool().Exec(ctxc(),
		`INSERT INTO attempt (workflow_id, step_type, number, state) VALUES ($1,'nope',1,'ISSUED')`,
		wf.ID); !isFKPG(err) {
		t.Fatalf("expected 23503 on attempt FK, got %v", err)
	}
	// (c) processed_events -> inbound_event foreign key.
	if _, err := testStore.Pool().Exec(ctxc(),
		`INSERT INTO processed_events (event_id, workflow_id) VALUES ($1,$2)`, id.New(), wf.ID); !isFKPG(err) {
		t.Fatalf("expected 23503 on processed_events FK, got %v", err)
	}
	// (d) terminal_coherence CHECK: a RUNNING (non-terminal) row may not carry finished_at.
	if _, err := testStore.Pool().Exec(ctxc(),
		`UPDATE workflow SET finished_at = now() WHERE id = $1`, wf.ID); !isCheckPG(err) {
		t.Fatalf("expected 23514 terminal_coherence violation, got %v", err)
	}
}

// TestStore_DS1Regression_TerminalNotReopened is the store-level twin of the pure
// engine regression: a re-authored late failure must not reopen a COMPLETED
// workflow, downgrade it, or emit a new command (closes DS-1/DS-1b).
func TestStore_DS1Regression_TerminalNotReopened(t *testing.T) {
	reset(t)
	done := driveToCompleted(t)
	if done.State != engine.StateCompleted {
		t.Fatalf("precondition: want COMPLETED, got %s", done.State)
	}
	outboxBefore := count(t, `SELECT count(*) FROM outbox WHERE workflow_id=$1`, done.ID)

	late := failEvent(done.ID, "reserve-room", 1, engine.ErrTerminal, done.Version)
	late.EventID = id.New() // a re-authored event with a fresh id
	class, err := testStore.ApplyResult(ctxc(), late, json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("late terminal event must be ignored, not error: %v", err)
	}
	if class != engine.ClassTerminalIgnored {
		t.Fatalf("class = %s, want TERMINAL_IGNORED", class)
	}
	after := loadState(t, done.ID)
	if after.State != engine.StateCompleted || after.Version != done.Version {
		t.Fatalf("terminal workflow mutated: %s/v%d", after.State, after.Version)
	}
	if count(t, `SELECT count(*) FROM outbox WHERE workflow_id=$1`, done.ID) != outboxBefore {
		t.Fatal("replayed event produced a new command (DS-1 recurrence)")
	}
	// The event is stored + classified, never silently dropped (SM §5).
	if count(t, `SELECT count(*) FROM inbound_event WHERE event_id=$1 AND classification='TERMINAL_IGNORED'`, late.EventID) != 1 {
		t.Fatal("late event not recorded as TERMINAL_IGNORED")
	}
	// Operator cancel of a terminal workflow is a typed refusal, not a rewrite.
	if _, err := testStore.Cancel(ctxc(), done.ID, done.Version); err == nil {
		t.Fatal("cancel of terminal workflow must be refused")
	} else {
		var tie engine.TerminalImmutableError
		if !errors.As(err, &tie) {
			t.Fatalf("want TerminalImmutableError, got %v", err)
		}
	}
}

// TestStore_CompensationFailureEscalates proves W12 durably: a failing
// compensator lands FAILED_MANUAL with a dead_letter row (SM W12, DATA §A.4).
func TestStore_CompensationFailureEscalates(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	// step0 succeeds -> step1 issued.
	wf = applyThenLoad(t, wf.ID, successEvent(wf.ID, "reserve-room", 1, wf.Version))
	// step1 fails TERMINAL -> COMPENSATING over reserve-room.
	wf = applyThenLoad(t, wf.ID, failEvent(wf.ID, "charge-payment", 1, engine.ErrTerminal, wf.Version))
	if wf.State != engine.StateCompensating {
		t.Fatalf("state = %s, want COMPENSATING", wf.State)
	}
	// compensator for reserve-room fails TERMINAL -> FAILED_MANUAL + DLQ.
	wf = applyThenLoad(t, wf.ID, failEvent(wf.ID, "reserve-room", 1, engine.ErrTerminal, wf.Version))
	if wf.State != engine.StateFailedManual {
		t.Fatalf("state = %s, want FAILED_MANUAL", wf.State)
	}
	if wf.State.IsTerminal() {
		t.Fatal("FAILED_MANUAL must be non-terminal (operable)")
	}
	if count(t, `SELECT count(*) FROM dead_letter WHERE workflow_id=$1 AND class='COMPENSATION'`, wf.ID) != 1 {
		t.Fatal("expected a COMPENSATION dead_letter row")
	}
	if count(t, `SELECT count(*) FROM audit_event WHERE workflow_id=$1 AND kind='DEADLETTER'`, wf.ID) < 1 {
		t.Fatal("expected a DEADLETTER audit row")
	}
}

// TestStore_NotFoundIsNotSilent confirms a genuine absence is typed NotFound,
// distinct from a storage fault (DS-13).
func TestStore_NotFoundIsNotSilent(t *testing.T) {
	reset(t)
	_, err := testStore.LoadWorkflow(ctxc(), id.New())
	var nf NotFoundError
	if !errors.As(err, &nf) {
		t.Fatalf("want NotFoundError, got %v", err)
	}
}

// TestStore_MigrateDownRoundTrip proves the versioned down migration fully
// reverses 0001 (every durable object gone, migrate version back to nil) and
// that re-applying up restores a clean, current, usable schema — the schema
// reproducibility guarantee Phase 4 documents.
func TestStore_MigrateDownRoundTrip(t *testing.T) {
	// TestMain migrated fresh, so the schema is at version 1 here.
	if err := testStore.MigrateDown(ctxc(), 1); err != nil {
		t.Fatalf("migrate down: %v", err)
	}
	v, dirty, err := testStore.SchemaVersion(ctxc())
	if err != nil {
		t.Fatalf("version after down: %v", err)
	}
	if dirty {
		t.Fatal("schema dirty after down")
	}
	if v != 0 {
		t.Fatalf("schema version after down = %d, want 0 (nil)", v)
	}
	if n := countTables(t, "workflow", "step", "attempt", "inbound_event",
		"processed_events", "outbox", "api_idempotency", "dead_letter", "audit_event"); n != 0 {
		t.Fatalf("durable tables remaining after down = %d, want 0", n)
	}
	// Re-apply up: schema returns to version 1, not dirty.
	if err := testStore.Migrate(ctxc()); err != nil {
		t.Fatalf("re-migrate up: %v", err)
	}
	v, dirty, err = testStore.SchemaVersion(ctxc())
	if err != nil {
		t.Fatalf("version after re-up: %v", err)
	}
	if dirty || v != 1 {
		t.Fatalf("after re-up version=%d dirty=%v, want version=1 dirty=false", v, dirty)
	}
	// Prove the re-created schema is genuinely live: a full create/start/apply
	// still drives a workflow to COMPLETED.
	wf := driveToCompleted(t)
	if wf.State != engine.StateCompleted {
		t.Fatalf("state after round-trip create = %s, want COMPLETED", wf.State)
	}
}

func countTables(t *testing.T, names ...string) int {
	t.Helper()
	var n int
	err := testStore.Pool().QueryRow(ctxc(),
		`SELECT count(*) FROM information_schema.tables
		  WHERE table_schema='public' AND table_name = ANY($1)`, names).Scan(&n)
	if err != nil {
		t.Fatalf("count tables: %v", err)
	}
	return n
}

// ---- error predicates local to the integration suite -----------------------

func isUniquePG(err error) bool { return pgCode(err, "23505") }
func isFKPG(err error) bool     { return pgCode(err, "23503") }
func isCheckPG(err error) bool  { return pgCode(err, "23514") }

func pgCode(err error, code string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}
