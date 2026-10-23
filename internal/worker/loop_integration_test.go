//go:build integration

package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/Lakhyajit-96/fathom/internal/engine"
	"github.com/Lakhyajit-96/fathom/internal/id"
	"github.com/Lakhyajit-96/fathom/internal/participant"
	"github.com/Lakhyajit-96/fathom/internal/scheduler"
	"github.com/Lakhyajit-96/fathom/internal/store/postgres"
)

// Loop-tier T-INT tests (brief §9): real worker + real scheduler/reaper loops
// against real PostgreSQL. Deterministic scripted participants only — the
// point is the RUNTIME's recovery behaviour, not any domain logic.

var store *postgres.Store

func TestMain(m *testing.M) {
	dsn := os.Getenv("FATHOM_TEST_DATABASE_URL")
	if dsn == "" {
		fmt.Println("integration: FATHOM_TEST_DATABASE_URL unset — skipping loop tests")
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

func createParams(steps ...engine.StepSpec) postgres.CreateParams {
	return postgres.CreateParams{
		IdempotencyKey: id.New(),
		DefName:        "loop-test",
		DefVersion:     1,
		DefSnapshot:    json.RawMessage(`{"note":"integration loop test"}`),
		BusinessKey:    "bk:" + id.New(),
		Input:          json.RawMessage(`{"n":1}`),
		Deadline:       time.Now().UTC().Add(time.Hour),
		Steps:          steps,
	}
}

// scripted is a deterministic test participant: outcomes keyed by attempt
// number, never by wall time or randomness.
type scripted struct {
	name string
	// fn decides (output, error) for each call; nil error => success.
	fn func(task participant.Task) (json.RawMessage, error)
	// block, when set, is waited on before consulting fn (interruptible).
	seen chan participant.Task
}

func newScripted(name string) *scripted {
	return &scripted{name: name, seen: make(chan participant.Task, 16)}
}

func (s *scripted) Execute(ctx context.Context, t participant.Task) (json.RawMessage, error) {
	s.seen <- t
	if s.fn != nil {
		return s.fn(t)
	}
	return json.RawMessage(`{"ok":true}`), nil
}

func okHandler(name string) *scripted { return newScripted(name) }

func mustSucceedWithin(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v: %s", timeout, what)
}

func wfState(t *testing.T, wfID string) engine.Workflow {
	t.Helper()
	wf, err := store.LoadWorkflow(context.Background(), wfID)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return wf
}

// runStack starts a worker+scheduler pair with tight loop timings and returns
// a stop function. Lease/reaper parameters are seconds-small to keep the
// failure injections fast and deterministic (durations, not real 90s TTLs).
func runStack(t *testing.T, reg *participant.Registry, lease time.Duration) func() {
	t.Helper()
	ctx := context.Background()
	w, err := New(store, reg, Config{
		LeaseTTL: lease, PollInterval: 50 * time.Millisecond,
		HeartbeatInterval: lease / 3,
	}, nil)
	if err != nil {
		t.Fatalf("worker new: %v", err)
	}
	w.Start(ctx)
	s, err := scheduler.New(store, scheduler.Config{
		Tick: 150 * time.Millisecond, Batch: 20,
		JitterFrac: func(string, int, time.Duration) time.Duration { return 0 },
	}, nil)
	if err != nil {
		t.Fatalf("scheduler new: %v", err)
	}
	s.Start(ctx)
	return func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.Shutdown(shutdownCtx)
		_ = w.Shutdown(shutdownCtx)
	}
}

// L-T01: full happy path driven ONLY by the loops — create QUEUED (W1), the
// scheduler starts it (W2), workers claim/execute/submit both steps, and the
// workflow reaches COMPLETED with a complete attempt ledger.
func TestLoop_HappyPath(t *testing.T) {
	resetDB(t)
	r1, r2 := okHandler("reserve-room"), okHandler("charge-payment")
	reg := participant.NewRegistry()
	reg.Register("reserve-room", r1)
	reg.Register("charge-payment", r2)
	stop := runStack(t, reg, 2*time.Second)
	defer stop()

	out, err := store.CreateWorkflow(context.Background(), createParams(
		engine.StepSpec{Type: "reserve-room", MaxAttempts: 3, Compensable: true},
		engine.StepSpec{Type: "charge-payment", MaxAttempts: 3},
	))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wfID := out.Workflow.ID
	mustSucceedWithin(t, 20*time.Second, "COMPLETED", func() bool {
		return wfState(t, wfID).State == engine.StateCompleted
	})
	if n := countDB(t, `SELECT count(*) FROM attempt WHERE workflow_id=$1 AND state='SUCCEEDED'`, wfID); n != 2 {
		t.Fatalf("succeeded attempts = %d, want 2", n)
	}
	// Each handler executed exactly once, at attempt 1, forward.
	for _, s := range []*scripted{r1, r2} {
		if got := drain(s.seen); len(got) != 1 || got[0].Attempt != 1 || got[0].Compensation {
			t.Fatalf("%s executions = %+v, want one forward attempt-1 call", s.name, got)
		}
	}
}

// L-T02: retryable failure at attempt 1 -> durable RETRY_WAITING -> reaper
// drives W6 (with the base backoff) -> attempt 2 succeeds -> COMPLETED.
func TestLoop_RetryThenSuccess(t *testing.T) {
	resetDB(t)
	r1 := newScripted("reserve-room")
	r1.fn = func(task participant.Task) (json.RawMessage, error) {
		if task.Attempt == 1 {
			return nil, participant.Retryable(errors.New("transient db timeout"))
		}
		return nil, nil
	}
	r2 := okHandler("charge-payment")
	reg := participant.NewRegistry()
	reg.Register("reserve-room", r1)
	reg.Register("charge-payment", r2)
	stop := runStack(t, reg, 2*time.Second)
	defer stop()

	out, err := store.CreateWorkflow(context.Background(), createParams(
		engine.StepSpec{Type: "reserve-room", MaxAttempts: 3, Compensable: true},
		engine.StepSpec{Type: "charge-payment", MaxAttempts: 3},
	))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wfID := out.Workflow.ID
	mustSucceedWithin(t, 30*time.Second, "COMPLETED after retry", func() bool {
		return wfState(t, wfID).State == engine.StateCompleted
	})
	if n := countDB(t, `SELECT count(*) FROM attempt WHERE workflow_id=$1 AND number=1 AND state='FAILED'`, wfID); n != 1 {
		t.Fatal("attempt 1 must be ledger-FAILED")
	}
	if n := countDB(t, `SELECT count(*) FROM attempt WHERE workflow_id=$1 AND number=2 AND state='SUCCEEDED'`, wfID); n != 1 {
		t.Fatal("attempt 2 must be ledger-SUCCEEDED")
	}
	// The retry reached the handler with the raised fencing token.
	var attempts []int
	for _, task := range drain(r1.seen) {
		attempts = append(attempts, task.Attempt)
	}
	if len(attempts) != 2 || attempts[1] != 2 {
		t.Fatalf("reserve-room executions = %v, want [1 2]", attempts)
	}
}

// L-T03: the worker dies mid-execution (simulated honestly: a SIGKILL-style
// context kill — the heartbeat stops, the lease simply expires). The reaper
// reclaims with a higher fencing token and a fresh worker completes the
// workflow. The dead worker's result can NEVER land (no heartbeat, no
// submit): the ledger proves it via LOST + a single SUCCEEDED attempt 2.
func TestLoop_WorkerDeathRecovery(t *testing.T) {
	resetDB(t)
	blocked := newScripted("reserve-room")
	blocked.fn = func(task participant.Task) (json.RawMessage, error) {
		if task.Attempt == 1 {
			select {} // hang forever: this worker "dies" with the lease held
		}
		return nil, nil
	}
	r2 := okHandler("charge-payment")
	reg := participant.NewRegistry()
	reg.Register("reserve-room", blocked)
	reg.Register("charge-payment", r2)

	ctx := context.Background()
	victimCtx, killVictim := context.WithCancel(ctx)
	defer killVictim()
	w1, err := New(store, reg, Config{
		ID: "victim", LeaseTTL: time.Second, PollInterval: 50 * time.Millisecond,
		HeartbeatInterval: 300 * time.Millisecond,
	}, nil)
	if err != nil {
		t.Fatalf("new victim: %v", err)
	}
	w1.Start(victimCtx) // kill = cancel ctx WITHOUT waiting: a process death
	s, err := scheduler.New(store, scheduler.Config{
		Tick: 150 * time.Millisecond, Batch: 20,
		JitterFrac: func(string, int, time.Duration) time.Duration { return 0 },
	}, nil)
	if err != nil {
		t.Fatalf("new scheduler: %v", err)
	}
	s.Start(ctx)
	defer func() { _ = s.Shutdown(timeoutCtx(t)) }()

	out, err := store.CreateWorkflow(ctx, createParams(
		engine.StepSpec{Type: "reserve-room", MaxAttempts: 3, Compensable: true},
		engine.StepSpec{Type: "charge-payment", MaxAttempts: 3},
	))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wfID := out.Workflow.ID

	// Wait until the victim has the step leased, then kill it (SIGKILL: no
	// graceful release — the lease in the database is the truth, and the
	// heartbeat is the only thing keeping it alive).
	mustSucceedWithin(t, 10*time.Second, "victim holds lease", func() bool {
		return countDB(t, `SELECT count(*) FROM step WHERE workflow_id=$1 AND step_type='reserve-room' AND lease_holder='victim'`, wfID) == 1
	})
	killVictim()

	// Lease expiry (≤1s) + reaper reclaim: attempt 1 settled LOST.
	mustSucceedWithin(t, 20*time.Second, "reclaim after lease expiry", func() bool {
		return countDB(t, `SELECT count(*) FROM attempt WHERE workflow_id=$1 AND number=1 AND state='LOST'`, wfID) == 1
	})
	// The step is re-issued at attempt 2 (fencing raised).
	mustSucceedWithin(t, 10*time.Second, "attempt 2 issued", func() bool {
		wf := wfState(t, wfID)
		for _, st := range wf.Steps {
			if st.Type == "reserve-room" {
				return st.ActiveAttempt == 2
			}
		}
		return false
	})
	// A healthy worker picks up attempt 2 (same scripted handler now succeeds)
	// and finishes the workflow. The victim is never gracefully shut down —
	// its loop goroutine is still hung, exactly like a real killed process's
	// memory that will never submit anything.
	w2, err := New(store, reg, Config{
		ID: "survivor", LeaseTTL: 2 * time.Second, PollInterval: 50 * time.Millisecond,
		HeartbeatInterval: 600 * time.Millisecond,
	}, nil)
	if err != nil {
		t.Fatalf("new survivor: %v", err)
	}
	w2.Start(ctx)
	defer func() { _ = w2.Shutdown(timeoutCtx(t)) }()

	mustSucceedWithin(t, 20*time.Second, "COMPLETED after worker death", func() bool {
		return wfState(t, wfID).State == engine.StateCompleted
	})
	// The hung attempt-1 result never applied: exactly one SUCCEEDED reserve
	// (attempt 2), and the victim's abandoned execution is recorded LOST.
	if n := countDB(t, `SELECT count(*) FROM attempt WHERE workflow_id=$1 AND step_type='reserve-room' AND state='SUCCEEDED' AND number=2`, wfID); n != 1 {
		t.Fatal("attempt 2 must have succeeded once")
	}
}

// L-T04: permanent failure on the final step drives the compensation chain
// THROUGH THE WORKER: the compensator task (declared on the definition) is
// claimed and executed, and the workflow terminates ABORTED.
func TestLoop_CompensationExecution(t *testing.T) {
	resetDB(t)
	r1 := okHandler("reserve-room")
	comp := okHandler("release-room")
	r2 := newScripted("charge-payment")
	r2.fn = func(participant.Task) (json.RawMessage, error) {
		return nil, participant.Permanent(errors.New("card declined"))
	}
	reg := participant.NewRegistry()
	reg.Register("reserve-room", r1)
	reg.Register("release-room", comp)
	reg.Register("charge-payment", r2)
	stop := runStack(t, reg, 2*time.Second)
	defer stop()

	out, err := store.CreateWorkflow(context.Background(), createParams(
		engine.StepSpec{Type: "reserve-room", MaxAttempts: 1, Compensable: true, CompensatorTask: "release-room"},
		engine.StepSpec{Type: "charge-payment", MaxAttempts: 1},
	))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wfID := out.Workflow.ID
	mustSucceedWithin(t, 20*time.Second, "ABORTED after compensation", func() bool {
		return wfState(t, wfID).State == engine.StateAborted
	})
	seen := drain(comp.seen)
	if len(seen) != 1 || !seen[0].Compensation || seen[0].Task != "release-room" {
		t.Fatalf("compensator executions = %+v, want one compensation claim", seen)
	}
	// The forward step's own task was never used for rollback (routing went
	// to the declared compensator task).
	for _, task := range drain(r1.seen) {
		if task.Compensation {
			t.Fatal("forward handler executed a compensation")
		}
	}
}

// L-T05: no registered handler for the task must produce a real terminal
// result, not silence: the workflow fails through the machine, the attempt is
// settled in the ledger.
func TestLoop_UnknownTaskFailsLoud(t *testing.T) {
	resetDB(t)
	reg := participant.NewRegistry() // nothing registered
	stop := runStack(t, reg, 2*time.Second)
	defer stop()

	out, err := store.CreateWorkflow(context.Background(), createParams(
		engine.StepSpec{Type: "mystery", MaxAttempts: 2},
	))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wfID := out.Workflow.ID
	mustSucceedWithin(t, 20*time.Second, "FAILED (unknown task)", func() bool {
		return wfState(t, wfID).State == engine.StateFailed
	})
	// Unknown task is classified TERMINAL, not retryable: the machine fails
	// the step immediately (W4) instead of burning the remaining budget. The
	// single attempt is ledger-recorded; nothing applied silently.
	if n := countDB(t, `SELECT count(*) FROM attempt WHERE workflow_id=$1 AND state='FAILED'`, wfID); n != 1 {
		t.Fatalf("failed attempts = %d, want 1 (terminal class, recorded)", n)
	}
}

// L-T06: the jitter gate is injectable and bounded: an all-window jitter
// delays driving W6 without the durable due-time ever being lost; zero
// jitter fires immediately. Proves both §4 requirements (jitter + injectable
// policy) against real rows.
func TestScheduler_JitterGate(t *testing.T) {
	resetDB(t)
	ctx := context.Background()
	out, err := store.CreateWorkflow(ctx, createParams(
		engine.StepSpec{Type: "slow-retry", MaxAttempts: 3, Compensable: false},
	))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wf, err := store.Start(ctx, out.Workflow.ID, out.Workflow.Version)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// Retryable failure -> RETRY_WAITING, schedule in the past for the test.
	ev := engine.ResultEvent{EventID: id.New(), WorkflowID: wf.ID, StepType: "slow-retry",
		Attempt: 1, Outcome: engine.OutcomeFailed, ErrorClass: engine.ErrRetryable, ExpectedVersion: wf.Version}
	if _, err := store.ApplyResult(ctx, ev, json.RawMessage(`{}`)); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if _, err := store.Pool().Exec(ctx,
		`UPDATE workflow SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, wf.ID); err != nil {
		t.Fatalf("age due: %v", err)
	}

	maxJitter := func(_ string, _ int, window time.Duration) time.Duration { return window }
	s, err := scheduler.New(store, scheduler.Config{Tick: 100 * time.Millisecond, JitterFrac: maxJitter}, nil)
	if err != nil {
		t.Fatalf("scheduler: %v", err)
	}
	s.Start(ctx)
	time.Sleep(600 * time.Millisecond) // several ticks
	if st := wfState(t, wf.ID); st.State != engine.StateRetryWaiting {
		t.Fatalf("max-jitter scheduler advanced W6: state=%s", st.State)
	}
	// The durable schedule was NOT rewritten or forgotten — still due in the
	// past, visible to any replica.
	_ = s.Shutdown(timeoutCtx(t))

	// Zero-jitter scheduler drives W6 at the durable due time exactly.
	s2, err := scheduler.New(store, scheduler.Config{Tick: 100 * time.Millisecond,
		JitterFrac: func(string, int, time.Duration) time.Duration { return 0 },
	}, nil)
	if err != nil {
		t.Fatalf("scheduler2: %v", err)
	}
	s2.Start(ctx)
	defer func() { _ = s2.Shutdown(timeoutCtx(t)) }()
	mustSucceedWithin(t, 5*time.Second, "W6 driven after gate removed", func() bool {
		return wfState(t, wf.ID).State == engine.StateRunning
	})
	// Default FullJitter is deterministic and within the window.
	w1 := scheduler.FullJitter("abc", 1, time.Minute)
	w2v := scheduler.FullJitter("abc", 1, time.Minute)
	if w1 != w2v || w1 < 0 || w1 >= time.Minute {
		t.Fatalf("FullJitter not deterministic/bounded: %v vs %v", w1, w2v)
	}
}

// ---- tiny local helpers -----------------------------------------------------

func countDB(t *testing.T, q string, args ...any) int {
	t.Helper()
	var n int
	if err := store.Pool().QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func drain(ch chan participant.Task) []participant.Task {
	var out []participant.Task
	for {
		select {
		case t := <-ch:
			out = append(out, t)
		default:
			return out
		}
	}
}

func timeoutCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}
