package engine

import "fmt"

// The functions in this file complete the transition table rows Phase 4 left
// as pure-core scope: the reaper-driven W13, the operator-driven W17/W18, and
// the lease-recovery re-issue of §4.3 (expired lease => the attempt is LOST and
// work continues under a higher fencing token). They are pure like the rest of
// the machine: no I/O, time and due-ness decided by the caller.

// ManualAction names the two authorized W17 resolutions of FAILED_MANUAL
// (SM §2 W17; PRODUCT REQ-OP-5). Nothing else can leave that state.
type ManualAction string

const (
	// ForceTerminate closes a FAILED_MANUAL workflow as FAILED: the operator
	// accepts the residual effects and terminates forward.
	ForceTerminate ManualAction = "force-terminate"
	// CompleteCompensation closes it as ABORTED: the operator declares the
	// compensation set reconciled; every outstanding compensable step is
	// recorded COMPENSATED.
	CompleteCompensation ManualAction = "complete-compensation"
)

func (a ManualAction) valid() bool {
	return a == ForceTerminate || a == CompleteCompensation
}

// EscalateDeadline drives W13: the workflow breached its durable deadline_at
// and no automatic path can complete it. The reaper decides *when* (it holds
// the row under SKIP LOCKED); this function decides *what*.
//
// Reading of W13's guard column ("if completed steps: compensators first via
// W7 chain, else direct"): an escalation that still has effects to roll back
// enters the compensation chain — giving the completed steps their specified
// treatment — and the durable dead-letter record appears only if the chain
// itself lands the workflow in FAILED_MANUAL (W12) or the escalation is
// direct. A DLQ item for a workflow that then ABORTs cleanly would be queue
// noise, contradicting SM §7 ("durable operator work"). The DEADLINE_ESCALATED
// audit is written in every case, so the escalation stays inspectable either
// way (REQ-OP-3).
//
// QUEUED is included in the direct arm as a documented extension: the machine
// provides bounded progress (REQ-C-5), and a workflow the scheduler could not
// even start must not stay open past its deadline. FAILED_MANUAL is inert —
// reaper and timers never advance it (§2 note †).
func EscalateDeadline(wf Workflow, expectedVersion int64) (Result, error) {
	out := wf.clone()
	if out.State.IsTerminal() {
		return Result{}, TerminalImmutableError{WorkflowID: out.ID, State: out.State}
	}
	if out.State == StateFailedManual {
		return Result{}, InvalidTransitionError{From: out.State, Reason: "deadline escalation: FAILED_MANUAL is inert"}
	}
	if err := guard(&out, expectedVersion); err != nil {
		return Result{}, err
	}

	if out.State == StateRunning || out.State == StateRetryWaiting {
		if set := out.completedCompensable(); len(set) > 0 {
			// Compensators first via the W7 chain, then W11/W12 decide the end.
			// The deadline just cost the in-flight forward step its chance to
			// answer: settle it TIMED_OUT so no late result can be applied as
			// forward work while the chain runs (compensation owns the workflow).
			for i := range out.Steps {
				if s := &out.Steps[i]; s.State == StepIssued || s.State == StepInProgress {
					s.State = StepTimedOut
				}
			}
			out.State = StateCompensating
			first := set[0]
			first.State = StepCompensating
			out.bump()
			return Result{Workflow: out, Effects: []Effect{
				audit("DEADLINE_ESCALATED", first.Type, first.ActiveAttempt),
				audit("COMPENSATION_STARTED", first.Type, first.ActiveAttempt),
				compensate(first.Type, first.ActiveAttempt, "COMPENSATION_ISSUED"),
			}}, nil
		}
	}

	// Direct arm: QUEUED, or nothing left to compensate, or a chain that
	// outlived the workflow deadline — a human must look at this.
	out.State = StateFailedManual
	out.bump()
	return Result{Workflow: out, Effects: []Effect{
		audit("DEADLINE_ESCALATED", "", -1),
		{Kind: EffectDeadLetter, ReasonCode: "DEADLINE", StepType: "", Attempt: -1},
	}}, nil
}

// ResolveManual drives W17: the only authorized exit from FAILED_MANUAL. It
// demands the operator's action name; actor/role/reason validation, the
// operator_action record, the DLQ resolution and the audit are the caller's
// (service layer) responsibility, in the same transaction as this write.
func ResolveManual(wf Workflow, expectedVersion int64, action ManualAction) (Result, error) {
	out := wf.clone()
	if out.State.IsTerminal() {
		return Result{}, TerminalImmutableError{WorkflowID: out.ID, State: out.State}
	}
	if !action.valid() {
		return Result{}, fmt.Errorf("engine: unknown manual action %q", string(action))
	}
	if err := guard(&out, expectedVersion); err != nil {
		return Result{}, err
	}
	if out.State != StateFailedManual {
		return Result{}, InvalidTransitionError{From: out.State, Reason: "manual resolution requires FAILED_MANUAL"}
	}

	var reason string
	if action == ForceTerminate {
		out.State = StateFailed
		reason = "OPERATOR_FORCE_TERMINATED"
	} else {
		// complete-compensation: the outstanding compensable set is declared
		// reconciled. Record every not-yet-COMPENSATED member as COMPENSATED
		// so step history reflects the operator's judgement (REQ-OP-2).
		for i := range out.Steps {
			st := &out.Steps[i]
			if st.Compensable && (st.State == StepSucceeded ||
				st.State == StepCompensationPending || st.State == StepCompensating ||
				st.State == StepCompensationFailed) {
				st.State = StepCompensated
			}
		}
		out.State = StateAborted
		reason = "OPERATOR_COMPENSATION_COMPLETED"
	}
	out.bump()
	return Result{Workflow: out, Effects: []Effect{audit(reason, "", -1)}}, nil
}

// RetryNow drives W18: an authorized operator retry of a RETRY_WAITING
// workflow, bypassing the remaining backoff but not the attempt budget — it
// produces the same next attempt W6 would, immediately, under the same guards.
func RetryNow(wf Workflow, expectedVersion int64) (Result, error) {
	out := wf.clone()
	if err := guard(&out, expectedVersion); err != nil {
		return Result{}, err
	}
	if out.State != StateRetryWaiting {
		return Result{}, InvalidTransitionError{From: out.State, Reason: "retry-now requires RETRY_WAITING"}
	}
	st := out.stepAwaitingRetry()
	if st == nil {
		return Result{}, InvalidTransitionError{From: out.State, Reason: "no step awaiting retry"}
	}
	st.ActiveAttempt++
	st.State = StepIssued
	out.State = StateRunning
	out.bump()
	return Result{Workflow: out, Effects: []Effect{
		audit("ATTEMPT_ISSUED_RETRY_NOW", st.Type, st.ActiveAttempt),
		command(st.Type, st.ActiveAttempt, "STEP_REISSUED"),
	}}, nil
}

// ReclaimLease is the engine half of §4.3 lease expiry: the live attempt of the
// named step is declared unrecoverable (the caller settles it LOST in the
// attempt ledger) and work proceeds under a HIGHER fencing token — a late
// result from the dead holder is then STALE by attempt, and its in-flight
// submission is refused by the store's lease check. When the forward budget is
// exhausted, reclaim takes the specified W7/W8 fork instead of looping (§8
// bounded retries; a dead worker cannot hold a workflow open forever).
//
// Compensation steps reclaim under a new attempt number too (same fencing
// logic), re-issuing the idempotent compensator command. CANCELLING workflows
// are NOT reclaimed forward: W14b lets the in-flight finish or releases the
// lease; the timeout path (TimeoutStep under CANCELLING) winds it down.
func ReclaimLease(wf Workflow, stepType string, expectedVersion int64) (Result, error) {
	out := wf.clone()
	if out.State.IsTerminal() {
		return Result{}, TerminalImmutableError{WorkflowID: out.ID, State: out.State}
	}
	if err := guard(&out, expectedVersion); err != nil {
		return Result{}, err
	}
	st := out.stepByType(stepType)
	if st == nil {
		return Result{}, UnknownStepError{WorkflowID: out.ID, StepType: stepType}
	}

	switch {
	case out.State == StateCompensating &&
		(st.State == StepCompensating || st.State == StepCompensationPending):
		lost := st.ActiveAttempt
		st.ActiveAttempt++
		st.State = StepCompensating
		out.bump()
		return Result{Workflow: out, Effects: []Effect{
			audit("LEASE_RECLAIMED", st.Type, lost),
			compensate(st.Type, st.ActiveAttempt, "COMPENSATION_REISSUED"),
		}}, nil

	case out.State == StateRunning &&
		(st.State == StepIssued || st.State == StepInProgress):
		out.bump()
		max := st.MaxAttempts
		if max <= 0 {
			max = 1
		}
		if st.ActiveAttempt < max {
			lost := st.ActiveAttempt
			st.ActiveAttempt++
			st.State = StepIssued
			return Result{Workflow: out, Effects: []Effect{
				audit("LEASE_RECLAIMED", st.Type, lost),
				command(st.Type, st.ActiveAttempt, "STEP_REISSUED_LEASE_RECOVERED"),
			}}, nil
		}
		// Budget gone: the lost attempt is the last one. Record the outcome,
		// then the standard termination fork decides COMPENSATING vs FAILED.
		st.State = StepTimedOut
		return beginTermination(out, st.Type, st.ActiveAttempt), nil

	default:
		return Result{}, InvalidTransitionError{From: out.State, Reason: "step is not an active lease holder"}
	}
}
