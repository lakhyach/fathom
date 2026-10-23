package engine

import (
	"errors"
	"testing"
	"time"
)

// TestFathom_DS1_ReplayedEventsDoNotAbortCompleted reproduces the upstream
// class of defect (DS-1 in RELIABILITY_AND_FAILURE_TEST_PLAN.md): a warm
// orchestrator that trusts inbound events unconditionally can be dragged out
// of a terminal state by a late or replayed message — e.g. a replayed failure
// flipping COMPLETED into ABORTED/COMPENSATING and re-issuing compensators.
//
// Here the workflow is driven to COMPLETED, then bombarded with the exact
// messages a misbehaving or replaying participant would send: a stale
// earlier-attempt failure, a re-authored fresh-ID failure, and a compensator
// result. None of them may mutate the workflow or enqueue durable side effects.
// Closes DS-1.
func TestFathom_DS1_ReplayedEventsDoNotAbortCompleted(t *testing.T) {
	wf := twoStepStarted(t)

	// Happy path to COMPLETED: step0 succeeds, step1 succeeds.
	r1, err := ApplyResult(wf, result("reserve-room", 1, OutcomeSucceeded, "", wf.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	done, err := ApplyResult(r1.Workflow, result("charge-payment", 1, OutcomeSucceeded, "", r1.Workflow.Version), false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if done.Workflow.State != StateCompleted {
		t.Fatalf("precondition: want COMPLETED, got %s", done.Workflow.State)
	}
	pin := done.Workflow

	// (a) Late failure from an obsolete attempt (attempt 1 while the ledger
	// recorded attempt 1 succeeded): must never reopen the saga.
	late := result("charge-payment", 1, OutcomeFailed, ErrRetryable, pin.Version)
	late.EventID = "evt-late-failure"
	res, err := ApplyResult(pin, late, false, t0.Add(time.Second))
	if err != nil {
		t.Fatalf("late event on terminal must be ignored, not error: %v", err)
	}
	if res.Classification != ClassTerminalIgnored {
		t.Fatalf("(a) class = %s, want TERMINAL_IGNORED", res.Classification)
	}
	assertUnaborted(t, "(a)", res, pin)

	// (b) Re-authored replay with a brand-new event ID and a FAILED outcome —
	// the exact shape that turned upstream's COMPLETED workflows into ABORTED.
	reauthored := result("reserve-room", 1, OutcomeFailed, ErrTerminal, pin.Version)
	reauthored.EventID = "evt-reauthored-failure"
	res, err = ApplyResult(pin, reauthored, false, t0.Add(time.Hour))
	if err != nil {
		t.Fatalf("(b) re-authored event must be ignored, not error: %v", err)
	}
	if res.Classification != ClassTerminalIgnored {
		t.Fatalf("(b) class = %s, want TERMINAL_IGNORED", res.Classification)
	}
	assertUnaborted(t, "(b)", res, pin)

	// (c) Compensator "success" for a step that already completed forward —
	// must not be interpreted as compensation progress.
	comp := result("reserve-room", 1, OutcomeSucceeded, "", pin.Version)
	comp.EventID = "evt-phantom-compensation"
	res, err = ApplyResult(pin, comp, false, t0.Add(time.Minute))
	if err != nil {
		t.Fatalf("(c) phantom compensation must be ignored, not error: %v", err)
	}
	assertUnaborted(t, "(c)", res, pin)

	// (d) Explicit operator cancel of a terminal workflow is a typed refusal,
	// never a silent COMPLETED -> ABORTED/FAILED rewrite.
	var tie TerminalImmutableError
	if _, err := Cancel(pin, pin.Version); !errors.As(err, &tie) {
		t.Fatalf("(d) want TerminalImmutableError, got %v", err)
	}
	if pin.State != StateCompleted {
		t.Fatalf("(d) cancel mutated terminal state to %s", pin.State)
	}
}

// assertUnaborted checks the DS-1 invariants on one application attempt: the
// workflow stayed COMPLETED at the pinned version, no step regressed, and no
// durable side effect (command/outbox re-issue or dead letter) was produced —
// i.e. the replay neither aborted the workflow nor triggered a new request.
func assertUnaborted(t *testing.T, label string, res Result, pin Workflow) {
	t.Helper()
	if res.Workflow.State != StateCompleted || res.Workflow.Version != pin.Version {
		t.Fatalf("%s: terminal workflow mutated: state=%s version=%d (pinned %s/v%d)",
			label, res.Workflow.State, res.Workflow.Version, pin.State, pin.Version)
	}
	for i := range res.Workflow.Steps {
		if res.Workflow.Steps[i].State != pin.Steps[i].State {
			t.Fatalf("%s: step %q regressed %s -> %s", label, pin.Steps[i].Type,
				pin.Steps[i].State, res.Workflow.Steps[i].State)
		}
	}
	for _, e := range res.Effects {
		if e.Kind == EffectOutbox || e.Kind == EffectDeadLetter {
			t.Fatalf("%s: replayed event produced a durable side effect: %+v", label, e)
		}
	}
}
