package engine

import (
	"errors"
	"testing"
	"time"
)

// Phase 5 engine coverage: W13 (deadline escalation), W17 (manual resolution),
// W18 (retry-now), §4.3 lease reclaim, and the TimeoutStep-under-CANCELLING
// regression (PHASE_5_SPEC_CHECKLIST §2.1).

func hasEffect(res Result, kind EffectKind, reason string) bool {
	for _, e := range res.Effects {
		if e.Kind == kind && e.ReasonCode == reason {
			return true
		}
	}
	return false
}

// completedWithActiveStep drives: step0 SUCCEEDED, step1 ISSUED (attempt 1).
func completedWithActiveStep(t *testing.T) Workflow {
	t.Helper()
	wf := twoStepStarted(t)
	r, err := ApplyResult(wf, result("reserve-room", 1, OutcomeSucceeded, "", wf.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	return r.Workflow
}

// TestEscalateDeadline_CompensatesFirst: RUNNING with a completed compensable
// step escalates into the W7 chain — never straight to FAILED_MANUAL — and
// audits the escalation (SM W13 guard, checklist §2.5 reading).
func TestEscalateDeadline_CompensatesFirst(t *testing.T) {
	wf := completedWithActiveStep(t)
	res, err := EscalateDeadline(wf, wf.Version)
	if err != nil {
		t.Fatal(err)
	}
	if res.Workflow.State != StateCompensating {
		t.Fatalf("state = %s, want COMPENSATING", res.Workflow.State)
	}
	if res.Workflow.Steps[0].State != StepCompensating {
		t.Fatalf("step0 = %s, want COMPENSATING (reverse-order set head)", res.Workflow.Steps[0].State)
	}
	if !hasEffect(res, EffectAudit, "DEADLINE_ESCALATED") || !hasEffect(res, EffectOutbox, "COMPENSATION_ISSUED") {
		t.Fatalf("missing escalation effects: %+v", res.Effects)
	}
	if hasEffect(res, EffectDeadLetter, "DEADLINE") {
		t.Fatal("compensating arm must not open a DLQ item yet (SM §7: operator work only)")
	}
}

// TestEscalateDeadline_Direct: nothing completed -> FAILED_MANUAL + durable
// DEADLINE dead-letter (REQ-C-5 landing; AT-08 tail).
func TestEscalateDeadline_Direct(t *testing.T) {
	wf := twoStepStarted(t) // step1 ISSUED, nothing SUCCEEDED
	res, err := EscalateDeadline(wf, wf.Version)
	if err != nil {
		t.Fatal(err)
	}
	if res.Workflow.State != StateFailedManual {
		t.Fatalf("state = %s, want FAILED_MANUAL", res.Workflow.State)
	}
	if !hasEffect(res, EffectDeadLetter, "DEADLINE") {
		t.Fatalf("missing DEADLINE dead-letter: %+v", res.Effects)
	}
	if res.Workflow.State.IsTerminal() {
		t.Fatal("FAILED_MANUAL must stay operator-resolvable (not terminal)")
	}
}

// TestEscalateDeadline_StalledChainAndInert: a COMPENSATING or CANCELLING
// workflow past its deadline lands in FAILED_MANUAL; FAILED_MANUAL itself is
// inert (no automatic advance); terminal workflows are untouchable.
func TestEscalateDeadline_StalledChainAndInert(t *testing.T) {
	wf := completedWithActiveStep(t)
	comp, err := EscalateDeadline(wf, wf.Version) // -> COMPENSATING (chain started)
	if err != nil {
		t.Fatal(err)
	}
	res, err := EscalateDeadline(comp.Workflow, comp.Workflow.Version)
	if err != nil {
		t.Fatal(err)
	}
	if res.Workflow.State != StateFailedManual {
		t.Fatalf("stalled chain state = %s, want FAILED_MANUAL", res.Workflow.State)
	}

	if _, err := EscalateDeadline(res.Workflow, res.Workflow.Version); err == nil {
		t.Fatal("FAILED_MANUAL is inert: reaper must not re-escalate it")
	}

	done, err := ResolveManual(res.Workflow, res.Workflow.Version, ForceTerminate)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := EscalateDeadline(done.Workflow, done.Workflow.Version); !errors.As(err, &TerminalImmutableError{}) {
		t.Fatalf("terminal escalation err = %v, want TerminalImmutableError", err)
	}
}

// TestResolveManual covers W17 both directions, guard rejection from other
// states, and the version guard.
func TestResolveManual(t *testing.T) {
	// Direct escalation arm (nothing completed yet) lands FAILED_MANUAL.
	wf := twoStepStarted(t)
	manual, err := EscalateDeadline(wf, wf.Version)
	if err != nil {
		t.Fatal(err)
	}
	if manual.Workflow.State != StateFailedManual {
		t.Fatalf("precondition: state = %s", manual.Workflow.State)
	}

	// force-terminate -> FAILED terminal.
	res, err := ResolveManual(manual.Workflow, manual.Workflow.Version, ForceTerminate)
	if err != nil {
		t.Fatal(err)
	}
	if res.Workflow.State != StateFailed || !res.Workflow.State.IsTerminal() {
		t.Fatalf("force-terminate state = %s, want FAILED", res.Workflow.State)
	}

	// complete-compensation -> ABORTED + outstanding compensable steps recorded COMPENSATED.
	res2, err := ResolveManual(manual.Workflow, manual.Workflow.Version, CompleteCompensation)
	if err != nil {
		t.Fatal(err)
	}
	if res2.Workflow.State != StateAborted {
		t.Fatalf("complete-compensation state = %s, want ABORTED", res2.Workflow.State)
	}

	// With a completed compensable step stranded by W12, the operator's
	// complete-compensation must record it COMPENSATED too.
	stuck := completedWithActiveStep(t)
	cf, err := ApplyResult(stuck, result("charge-payment", 1, OutcomeFailed, ErrTerminal, stuck.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	// Drive the chain to FAILED_MANUAL via a terminal compensator failure.
	man, err := ApplyResult(cf.Workflow, result("reserve-room", 1, OutcomeFailed, ErrTerminal, cf.Workflow.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if man.Workflow.State != StateFailedManual {
		t.Fatalf("W12 precondition: state = %s", man.Workflow.State)
	}
	res3, err := ResolveManual(man.Workflow, man.Workflow.Version, CompleteCompensation)
	if err != nil {
		t.Fatal(err)
	}
	if res3.Workflow.Steps[0].State != StepCompensated {
		t.Fatalf("step0 = %s, want COMPENSATED by operator declaration", res3.Workflow.Steps[0].State)
	}

	// Guards: wrong source state, wrong version, unknown action.
	run := twoStepStarted(t)
	if _, err := ResolveManual(run, run.Version, ForceTerminate); err == nil {
		t.Fatal("resolve from RUNNING must be refused")
	}
	if _, err := ResolveManual(run, run.Version+5, ForceTerminate); !errors.As(err, &StaleVersionError{}) {
		t.Fatalf("stale version err = %v", err)
	}
	if _, err := ResolveManual(manual.Workflow, manual.Workflow.Version, ManualAction("replay-raw-event")); err == nil {
		t.Fatal("unknown action must be refused (SM §7: raw re-emit is not an available action)")
	}
}

// TestRetryNow covers W18: bypasses the remaining backoff but not the budget —
// same next attempt as W6, immediately, with its own audit reason.
func TestRetryNow(t *testing.T) {
	wf := twoStepStarted(t)
	fail, err := ApplyResult(wf, result("reserve-room", 1, OutcomeFailed, ErrRetryable, wf.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if fail.Workflow.State != StateRetryWaiting {
		t.Fatalf("precondition: state = %s", fail.Workflow.State)
	}
	res, err := RetryNow(fail.Workflow, fail.Workflow.Version)
	if err != nil {
		t.Fatal(err)
	}
	if res.Workflow.State != StateRunning || res.Workflow.Steps[0].ActiveAttempt != 2 {
		t.Fatalf("retry-now: state=%s attempt=%d, want RUNNING/2", res.Workflow.State, res.Workflow.Steps[0].ActiveAttempt)
	}
	if !hasEffect(res, EffectOutbox, "STEP_REISSUED") || !hasEffect(res, EffectAudit, "ATTEMPT_ISSUED_RETRY_NOW") {
		t.Fatalf("missing retry-now effects: %+v", res.Effects)
	}
	if !res.NextAttemptAt.IsZero() {
		t.Fatal("retry-now must not schedule a new backoff")
	}
	// Not allowed outside RETRY_WAITING.
	if _, err := RetryNow(res.Workflow, res.Workflow.Version); err == nil {
		t.Fatal("retry-now from RUNNING must be refused")
	}
}

// TestReclaimLease_ForwardWithinBudget: expired lease -> LOST attempt replaced
// by a HIGHER fencing token, command re-issued under the same idempotent key
// (SM §4.3; the store settles the old attempt row LOST from the audit effect).
func TestReclaimLease_ForwardWithinBudget(t *testing.T) {
	wf := completedWithActiveStep(t) // step1 ISSUED attempt 1
	res, err := ReclaimLease(wf, "charge-payment", wf.Version)
	if err != nil {
		t.Fatal(err)
	}
	st := res.Workflow.Steps[1]
	if st.State != StepIssued || st.ActiveAttempt != 2 {
		t.Fatalf("reclaimed step: state=%s attempt=%d, want ISSUED/2", st.State, st.ActiveAttempt)
	}
	if !hasEffect(res, EffectAudit, "LEASE_RECLAIMED") || !hasEffect(res, EffectOutbox, "STEP_REISSUED_LEASE_RECOVERED") {
		t.Fatalf("missing reclaim effects: %+v", res.Effects)
	}
	// The dead holder's late result is now stale by fencing (attempt 1 < 2).
	late, err := ApplyResult(res.Workflow, result("charge-payment", 1, OutcomeSucceeded, "", res.Workflow.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if late.Classification != ClassStale {
		t.Fatalf("late superseded result class = %s, want STALE", late.Classification)
	}
}

// TestReclaimLease_BudgetExhausted: a dead worker cannot hold a workflow open
// forever — at budget the reclaim takes the W7/W8 fork.
func TestReclaimLease_BudgetExhausted(t *testing.T) {
	wf := completedWithActiveStep(t)
	// Push step1 to its last attempt (max 3) via timeouts + retries.
	v := wf.Version
	for attempt := 1; attempt < 3; attempt++ {
		to, err := TimeoutStep(wf, "charge-payment", v, t0.Add(time.Duration(attempt)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		v = to.Workflow.Version
		if to.Workflow.State != StateRetryWaiting {
			t.Fatalf("mid-loop state = %s, want RETRY_WAITING", to.Workflow.State)
		}
		re, err := Retry(to.Workflow, v, t0)
		if err != nil {
			t.Fatal(err)
		}
		wf, v = re.Workflow, re.Workflow.Version
	}
	// wf is RUNNING with step1 ISSUED at attempt 3 == max. Reclaim must terminate, not loop.
	res, err := ReclaimLease(wf, "charge-payment", v)
	if err != nil {
		t.Fatal(err)
	}
	if res.Workflow.State != StateCompensating {
		t.Fatalf("exhausted reclaim state = %s, want COMPENSATING (W7 over the completed step)", res.Workflow.State)
	}
	if hasEffect(res, EffectOutbox, "STEP_REISSUED_LEASE_RECOVERED") {
		t.Fatal("exhausted lease must not re-issue the forward step")
	}
}

// TestReclaimLease_Compensation: an expired compensator lease re-issues the
// idempotent compensator command under a new attempt (same fencing logic).
func TestReclaimLease_Compensation(t *testing.T) {
	wf := completedWithActiveStep(t)
	fail, err := ApplyResult(wf, result("charge-payment", 1, OutcomeFailed, ErrTerminal, wf.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if fail.Workflow.State != StateCompensating {
		t.Fatalf("precondition: state = %s, want COMPENSATING", fail.Workflow.State)
	}
	res, err := ReclaimLease(fail.Workflow, "reserve-room", fail.Workflow.Version)
	if err != nil {
		t.Fatal(err)
	}
	if res.Workflow.State != StateCompensating || res.Workflow.Steps[0].State != StepCompensating {
		t.Fatalf("compensation reclaim: wf=%s step=%s", res.Workflow.State, res.Workflow.Steps[0].State)
	}
	if !hasEffect(res, EffectOutbox, "COMPENSATION_REISSUED") {
		t.Fatalf("missing re-issue: %+v", res.Effects)
	}
	// A pending/unknown step cannot be reclaimed; CANCELLING does not reclaim forward.
	if _, err := ReclaimLease(fail.Workflow, "does-not-exist", fail.Workflow.Version); err == nil {
		t.Fatal("unknown step reclaim must fail")
	}
	run := twoStepStarted(t)
	cancelled, err := Cancel(run, run.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReclaimLease(cancelled.Workflow, "reserve-room", cancelled.Workflow.Version); err == nil {
		t.Fatal("CANCELLING must never reclaim forward leases (W14b)")
	}
}

// TestTimeoutWhileCancelling is the checklist §2.1 regression: the table has no
// CANCELLING -> RETRY_WAITING edge; a response deadline during wind-down goes
// to the termination fork, so the scheduler can never re-issue forward work
// against an accepted cancel.
func TestTimeoutWhileCancelling(t *testing.T) {
	wf := completedWithActiveStep(t) // step0 SUCCEEDED, step1 ISSUED
	c, err := Cancel(wf, wf.Version)
	if err != nil {
		t.Fatal(err)
	}
	if c.Workflow.State != StateCancelling {
		t.Fatalf("precondition: state = %s", c.Workflow.State)
	}
	res, err := TimeoutStep(c.Workflow, "charge-payment", c.Workflow.Version, t0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Workflow.State == StateRetryWaiting {
		t.Fatal("timeout during CANCELLING produced the illegal CANCELLING -> RETRY_WAITING edge")
	}
	if res.Workflow.State != StateCompensating {
		t.Fatalf("state = %s, want COMPENSATING (wind down over the completed step)", res.Workflow.State)
	}
	// And the wind-down still lands ABORTED, never COMPLETED (§10).
	done, err := ApplyResult(res.Workflow, result("reserve-room", 1, OutcomeSucceeded, "", res.Workflow.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if done.Workflow.State != StateAborted {
		t.Fatalf("cancel wind-down final state = %s, want ABORTED", done.Workflow.State)
	}
}

// TestRetryAfterTimeout is the Phase-4 latent-gap regression (checklist
// follow-up to §2.1): TimeoutStep enters RETRY_WAITING with the step settled
// TIMED_OUT, so W6/W18 must find a TIMED_OUT step awaiting its next attempt —
// otherwise every timed-out workflow stalls in RETRY_WAITING forever.
func TestRetryAfterTimeout(t *testing.T) {
	wf := twoStepStarted(t)
	to, err := TimeoutStep(wf, "reserve-room", wf.Version, t0)
	if err != nil {
		t.Fatal(err)
	}
	if to.Workflow.State != StateRetryWaiting || to.Workflow.Steps[0].State != StepTimedOut {
		t.Fatalf("after timeout: wf=%s step=%s", to.Workflow.State, to.Workflow.Steps[0].State)
	}
	re, err := Retry(to.Workflow, to.Workflow.Version, t0.Add(2*time.Second))
	if err != nil {
		t.Fatalf("W6 after timeout: %v", err)
	}
	if re.Workflow.State != StateRunning || re.Workflow.Steps[0].ActiveAttempt != 2 {
		t.Fatalf("retry: state=%s attempt=%d, want RUNNING/2", re.Workflow.State, re.Workflow.Steps[0].ActiveAttempt)
	}
}

// TestStepSpecDefaults pins the §8 normative defaults for the new definition data.
func TestStepSpecDefaults(t *testing.T) {
	sp := StepSpec{Type: "reserve-room"}
	if sp.Timeout() != 60*time.Second {
		t.Fatalf("default timeout = %v, want 60s", sp.Timeout())
	}
	if sp.Compensator() != "reserve-room" {
		t.Fatalf("default compensator = %q, want own type", sp.Compensator())
	}
	sp2 := StepSpec{Type: "reserve-room", CompensatorTask: "release-room", ForwardTimeout: 2 * time.Second}
	if sp2.Compensator() != "release-room" || sp2.Timeout() != 2*time.Second {
		t.Fatalf("overrides not honoured: %+v", sp2)
	}
}
