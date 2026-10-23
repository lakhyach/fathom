package engine

import (
	"errors"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC)

func twoStepStarted(t *testing.T) Workflow {
	t.Helper()
	wf, _ := Create("wf-1", []StepSpec{
		{Type: "reserve-room", MaxAttempts: 3, Compensable: true},
		{Type: "charge-payment", MaxAttempts: 3, Compensable: true},
	})
	res, err := Start(wf, wf.Version, t0)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if res.Workflow.State != StateRunning {
		t.Fatalf("start state = %s, want RUNNING", res.Workflow.State)
	}
	return res.Workflow
}

func result(step string, attempt int, outcome Outcome, class ErrorClass, v int64) ResultEvent {
	return ResultEvent{
		EventID: "evt-" + step, WorkflowID: "wf-1", StepType: step,
		Attempt: attempt, Outcome: outcome, ErrorClass: class, ExpectedVersion: v,
	}
}

// TestHappyPath drives the full forward chain to COMPLETED and checks state,
// version monotonicity, and that the final transition issues no further command.
func TestHappyPath(t *testing.T) {
	wf := twoStepStarted(t)

	r1, err := ApplyResult(wf, result("reserve-room", 1, OutcomeSucceeded, "", wf.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if r1.Classification != ClassApplied {
		t.Fatalf("step0 class = %s, want APPLIED", r1.Classification)
	}
	if r1.Workflow.State != StateRunning || r1.Workflow.Steps[1].State != StepIssued {
		t.Fatalf("after step0: state=%s step1=%s", r1.Workflow.State, r1.Workflow.Steps[1].State)
	}

	r2, err := ApplyResult(r1.Workflow, result("charge-payment", 1, OutcomeSucceeded, "", r1.Workflow.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if r2.Workflow.State != StateCompleted || !r2.Workflow.State.IsTerminal() {
		t.Fatalf("final state = %s, want COMPLETED", r2.Workflow.State)
	}
	if r2.Workflow.Version != wf.Version+2 {
		t.Fatalf("version = %d, want %d", r2.Workflow.Version, wf.Version+2)
	}
	for _, e := range r2.Effects {
		if e.Kind == EffectOutbox {
			t.Fatalf("COMPLETED transition must not publish a command, got %+v", e)
		}
	}
}

// TestTerminalImmutable is AT-01/AT-12 in its purest form: no APPLIED event or
// replay can move a terminal workflow (REQ-C-1, DS-1 closure).
func TestTerminalImmutable(t *testing.T) {
	wf := twoStepStarted(t)
	r1, _ := ApplyResult(wf, result("reserve-room", 1, OutcomeSucceeded, "", wf.Version), false, t0)
	done, _ := ApplyResult(r1.Workflow, result("charge-payment", 1, OutcomeSucceeded, "", r1.Workflow.Version), false, t0)
	before := done.Workflow

	// Re-authored equivalent result with a fresh event id (exactly Phase 1 §5.1):
	fresh := result("charge-payment", 1, OutcomeSucceeded, "", before.Version)
	fresh.EventID = "evt-reauthored"
	res, err := ApplyResult(before, fresh, false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Classification != ClassTerminalIgnored {
		t.Fatalf("class = %s, want TERMINAL_IGNORED", res.Classification)
	}
	if res.Workflow.State != StateCompleted || res.Workflow.Version != before.Version {
		t.Fatalf("terminal workflow mutated: state=%s version=%d", res.Workflow.State, res.Workflow.Version)
	}
	// No outbox rows on an ignored event.
	for _, e := range res.Effects {
		if e.Kind == EffectOutbox || e.Kind == EffectDeadLetter {
			t.Fatalf("TERMINAL_IGNORED produced a durable side effect: %+v", e)
		}
	}
}

func TestClassification(t *testing.T) {
	wf := twoStepStarted(t)

	t.Run("duplicate", func(t *testing.T) {
		res, err := ApplyResult(wf, result("reserve-room", 1, OutcomeSucceeded, "", wf.Version), true, t0)
		if err != nil || res.Classification != ClassDuplicate {
			t.Fatalf("got %s (%v), want DUPLICATE", res.Classification, err)
		}
		if res.Workflow.Version != wf.Version {
			t.Fatal("duplicate mutated version")
		}
	})

	t.Run("unsolicited_unknown_step", func(t *testing.T) {
		res, _ := ApplyResult(wf, result("ghost", 1, OutcomeSucceeded, "", wf.Version), false, t0)
		if res.Classification != ClassUnsolicited {
			t.Fatalf("got %s, want UNSOLICITED", res.Classification)
		}
	})

	t.Run("unsolicited_pending_step", func(t *testing.T) {
		// step1 is PENDING (not yet started); a result for it is unsolicited.
		res, _ := ApplyResult(wf, result("charge-payment", 1, OutcomeSucceeded, "", wf.Version), false, t0)
		if res.Classification != ClassUnsolicited {
			t.Fatalf("got %s, want UNSOLICITED", res.Classification)
		}
	})

	t.Run("stale_attempt", func(t *testing.T) {
		// advance step0 to attempt 2 via retry, then a late attempt-1 result.
		w := retryToAttempt2(t, wf)
		res, _ := ApplyResult(w, result("reserve-room", 1, OutcomeSucceeded, "", w.Version), false, t0)
		if res.Classification != ClassStale {
			t.Fatalf("got %s, want STALE (obsolete attempt)", res.Classification)
		}
	})
}

func TestStaleVersionRejected(t *testing.T) {
	wf := twoStepStarted(t)
	_, err := ApplyResult(wf, result("reserve-room", 1, OutcomeSucceeded, "", wf.Version-1), false, t0)
	var sv StaleVersionError
	if !errors.As(err, &sv) {
		t.Fatalf("want StaleVersionError, got %v", err)
	}
}

// TestRetryableFailureThenRetry covers W5 -> W6: a retryable failure schedules
// a durable retry, and Retry mints the next attempt (fencing token).
func TestRetryableFailureThenRetry(t *testing.T) {
	wf := twoStepStarted(t)
	r, err := ApplyResult(wf, result("reserve-room", 1, OutcomeFailed, ErrRetryable, wf.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if r.Workflow.State != StateRetryWaiting {
		t.Fatalf("state = %s, want RETRY_WAITING", r.Workflow.State)
	}
	if !r.NextAttemptAt.After(t0) {
		t.Fatalf("no durable next_attempt_at: %v", r.NextAttemptAt)
	}
	if got := r.NextAttemptAt.Sub(t0); got != 2*time.Second {
		t.Fatalf("backoff(attempt1) = %v, want 2s", got)
	}

	r2, err := Retry(r.Workflow, r.Workflow.Version, t0.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if r2.Workflow.State != StateRunning || r2.Workflow.Steps[0].ActiveAttempt != 2 {
		t.Fatalf("retry: state=%s attempt=%d", r2.Workflow.State, r2.Workflow.Steps[0].ActiveAttempt)
	}
	if r2.Workflow.Steps[0].State != StepIssued {
		t.Fatalf("retry step state = %s, want ISSUED", r2.Workflow.Steps[0].State)
	}
}

// TestRetryBudgetExhausted: attempt 3 of 3 failing terminally yields W8 FAILED
// (no prior completed steps to compensate).
func TestRetryBudgetExhausted(t *testing.T) {
	w := retryToAttempt2(t, twoStepStarted(t))
	// attempt2 fails retryable -> still under budget (max 3) -> RETRY_WAITING
	r2, _ := ApplyResult(w, result("reserve-room", 2, OutcomeFailed, ErrRetryable, w.Version), false, t0)
	if r2.Workflow.State != StateRetryWaiting {
		t.Fatalf("attempt2 should still be retryable, got %s", r2.Workflow.State)
	}
	// retry to attempt3
	r3, _ := Retry(r2.Workflow, r2.Workflow.Version, t0)
	if r3.Workflow.Steps[0].ActiveAttempt != 3 {
		t.Fatalf("want attempt 3, got %d", r3.Workflow.Steps[0].ActiveAttempt)
	}
	// attempt3 fails retryable -> budget exhausted, nothing completed -> FAILED
	r4, _ := ApplyResult(r3.Workflow, result("reserve-room", 3, OutcomeFailed, ErrRetryable, r3.Workflow.Version), false, t0)
	if r4.Workflow.State != StateFailed || !r4.Workflow.State.IsTerminal() {
		t.Fatalf("want FAILED terminal, got %s", r4.Workflow.State)
	}
}

// TestTerminalErrorNeverRetries: a TERMINAL failure goes straight to the
// termination fork (no RETRY_WAITING), regardless of remaining budget.
func TestTerminalErrorNeverRetries(t *testing.T) {
	wf := twoStepStarted(t)
	r, _ := ApplyResult(wf, result("reserve-room", 1, OutcomeFailed, ErrTerminal, wf.Version), false, t0)
	if r.Workflow.State != StateFailed {
		t.Fatalf("TERMINAL failure = %s, want FAILED (no completed steps to compensate)", r.Workflow.State)
	}
}

// TestCompensationOrderAndAbort: with step0 completed and step1 failing
// terminally, compensators run in REVERSE over completed steps then ABORT.
func TestCompensationOrderAndAbort(t *testing.T) {
	wf := twoStepStarted(t)
	// step0 succeeds -> step1 issued.
	r1, _ := ApplyResult(wf, result("reserve-room", 1, OutcomeSucceeded, "", wf.Version), false, t0)
	// step1 fails TERMINAL -> W7 compensate last completed (reserve-room).
	r2, _ := ApplyResult(r1.Workflow, result("charge-payment", 1, OutcomeFailed, ErrTerminal, r1.Workflow.Version), false, t0)
	if r2.Workflow.State != StateCompensating {
		t.Fatalf("state = %s, want COMPENSATING", r2.Workflow.State)
	}
	if r2.Workflow.Steps[0].State != StepCompensating {
		t.Fatalf("reserve-room should be COMPENSATING, got %s", r2.Workflow.Steps[0].State)
	}
	// find a compensator command in effects
	var comp *Effect
	for i := range r2.Effects {
		if r2.Effects[i].IsCompensation {
			comp = &r2.Effects[i]
		}
	}
	if comp == nil || comp.StepType != "reserve-room" {
		t.Fatalf("expected compensator command for reserve-room, got %+v", r2.Effects)
	}
	// compensator for reserve-room succeeds -> no more to compensate -> ABORTED.
	r3, _ := ApplyResult(r2.Workflow, result("reserve-room", 1, OutcomeSucceeded, "", r2.Workflow.Version), false, t0)
	if r3.Workflow.State != StateAborted || !r3.Workflow.State.IsTerminal() {
		t.Fatalf("want ABORTED, got %s", r3.Workflow.State)
	}
}

// TestCompensationFailureEscalates is AT-07/REQ-OP-4 in pure form: a failing
// compensator lands FAILED_MANUAL with a durable dead-letter intent, and the
// FAILED_MANUAL state is inert (a later event cannot auto-advance it).
func TestCompensationFailureEscalates(t *testing.T) {
	wf := twoStepStarted(t)
	r1, _ := ApplyResult(wf, result("reserve-room", 1, OutcomeSucceeded, "", wf.Version), false, t0)
	r2, _ := ApplyResult(r1.Workflow, result("charge-payment", 1, OutcomeFailed, ErrTerminal, r1.Workflow.Version), false, t0)
	r3, _ := ApplyResult(r2.Workflow, result("reserve-room", 1, OutcomeFailed, ErrTerminal, r2.Workflow.Version), false, t0)
	if r3.Workflow.State != StateFailedManual {
		t.Fatalf("want FAILED_MANUAL, got %s", r3.Workflow.State)
	}
	if r3.Workflow.State.IsTerminal() {
		t.Fatal("FAILED_MANUAL must be non-terminal (operable)")
	}
	var dl bool
	for _, e := range r3.Effects {
		if e.Kind == EffectDeadLetter {
			dl = true
		}
	}
	if !dl {
		t.Fatal("expected a dead-letter effect on compensation failure")
	}
	// inert: an inbound result cannot advance FAILED_MANUAL automatically.
	inert, _ := ApplyResult(r3.Workflow, result("reserve-room", 1, OutcomeSucceeded, "", r3.Workflow.Version), false, t0)
	if !sameState(inert.Workflow, r3.Workflow) {
		t.Fatal("FAILED_MANUAL was mutated by an inbound event (must be inert)")
	}
}

func TestCancelEdges(t *testing.T) {
	t.Run("queued_to_failed", func(t *testing.T) {
		wf, _ := Create("wf-c", []StepSpec{{Type: "a", MaxAttempts: 1}})
		res, err := Cancel(wf, wf.Version)
		if err != nil || res.Workflow.State != StateFailed {
			t.Fatalf("W14: got %s (%v)", res.Workflow.State, err)
		}
	})
	t.Run("running_to_cancelling", func(t *testing.T) {
		wf := twoStepStarted(t)
		res, err := Cancel(wf, wf.Version)
		if err != nil || res.Workflow.State != StateCancelling {
			t.Fatalf("W14b: got %s (%v)", res.Workflow.State, err)
		}
	})
	t.Run("compensating_rejected", func(t *testing.T) {
		wf := twoStepStarted(t)
		r1, _ := ApplyResult(wf, result("reserve-room", 1, OutcomeSucceeded, "", wf.Version), false, t0)
		r2, _ := ApplyResult(r1.Workflow, result("charge-payment", 1, OutcomeFailed, ErrTerminal, r1.Workflow.Version), false, t0)
		if _, err := Cancel(r2.Workflow, r2.Workflow.Version); err == nil {
			t.Fatal("cancel during COMPENSATING must be rejected")
		}
	})
	t.Run("terminal_rejected", func(t *testing.T) {
		wf := twoStepStarted(t)
		r1, _ := ApplyResult(wf, result("reserve-room", 1, OutcomeSucceeded, "", wf.Version), false, t0)
		done, _ := ApplyResult(r1.Workflow, result("charge-payment", 1, OutcomeSucceeded, "", r1.Workflow.Version), false, t0)
		var tie TerminalImmutableError
		_, err := Cancel(done.Workflow, done.Workflow.Version)
		if !errors.As(err, &tie) {
			t.Fatalf("cancel of terminal want TerminalImmutableError, got %v", err)
		}
	})
}

func TestTimeoutThenRetry(t *testing.T) {
	wf := twoStepStarted(t)
	res, err := TimeoutStep(wf, "reserve-room", wf.Version, t0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Workflow.State != StateRetryWaiting {
		t.Fatalf("timeout with budget = %s, want RETRY_WAITING", res.Workflow.State)
	}
}

// retryToAttempt2 helper drives a retryable failure + retry to reach attempt 2.
func retryToAttempt2(t *testing.T, wf Workflow) Workflow {
	t.Helper()
	r, _ := ApplyResult(wf, result("reserve-room", 1, OutcomeFailed, ErrRetryable, wf.Version), false, t0)
	r2, err := Retry(r.Workflow, r.Workflow.Version, t0)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	return r2.Workflow
}

func sameState(a, b Workflow) bool {
	if a.State != b.State || a.Version != b.Version {
		return false
	}
	for i := range a.Steps {
		if a.Steps[i].State != b.Steps[i].State || a.Steps[i].ActiveAttempt != b.Steps[i].ActiveAttempt {
			return false
		}
	}
	return true
}
