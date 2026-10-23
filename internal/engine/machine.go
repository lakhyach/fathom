package engine

import "time"

// The functions in this file implement WORKFLOW_STATE_MACHINE §2/§3/§5 as pure
// transformations. They never mutate the input snapshot: each returns a new
// Workflow plus the ordered set of durable Effects a transaction must write.
// Time is always passed in (`now`) so behaviour is deterministic and testable.

// StepSpec is the declared form of a step used at creation. The timeout and
// compensator-task fields are definition data (SM §1): the machine itself never
// reasons about durations — the store stamps durable deadlines from them and
// the scheduler enforces — but they ride the same pinned snapshot.
type StepSpec struct {
	Type            string
	MaxAttempts     int
	Compensable     bool
	CompensatorTask string        // empty => the step's own Type
	ForwardTimeout  time.Duration // 0 => engine.DefaultResponseTimeout
}

// DefaultResponseTimeout is the SM §8 normative forward timeout (issue->result,
// 60 s). Per-step overrides ride StepSpec.ForwardTimeout.
const DefaultResponseTimeout = 60 * time.Second

// Timeout returns the declared forward timeout or the normative default.
func (sp StepSpec) Timeout() time.Duration {
	if sp.ForwardTimeout > 0 {
		return sp.ForwardTimeout
	}
	return DefaultResponseTimeout
}

// Compensator returns the declared compensator task name for the step.
func (sp StepSpec) Compensator() string {
	if sp.CompensatorTask != "" {
		return sp.CompensatorTask
	}
	return sp.Type
}

// Create builds the W1 initial workflow: state QUEUED, version 1, every step
// PENDING in declaration order. Effects are the creation audit plus the
// intent to issue the first step's command (§6 outbox rule: the issue lives in
// the same transaction as the creation).
func Create(id string, steps []StepSpec) (Workflow, []Effect) {
	wf := Workflow{ID: id, State: StateQueued, Version: 1}
	for i, sp := range steps {
		max := sp.MaxAttempts
		if max <= 0 {
			max = 1
		}
		wf.Steps = append(wf.Steps, Step{
			Type: sp.Type, Position: i, State: StepPending,
			ActiveAttempt: 0, MaxAttempts: max, Compensable: sp.Compensable,
		})
	}
	var effects []Effect
	if len(wf.Steps) > 0 {
		effects = append(effects, command(wf.Steps[0].Type, 1, "WORKFLOW_CREATED"))
	}
	effects = append(effects, audit("WORKFLOW_CREATED", "", -1))
	return wf, effects
}

// Start drives W2 (QUEUED -> RUNNING) when the engine issues the first command.
func Start(wf Workflow, expectedVersion int64, now time.Time) (Result, error) {
	out := wf.clone()
	if err := guard(&out, expectedVersion); err != nil {
		return Result{}, err
	}
	if out.State != StateQueued {
		return Result{}, InvalidTransitionError{From: out.State, Reason: "start requires QUEUED"}
	}
	out.State = StateRunning
	out.bump()
	out.Steps[0].State = StepIssued
	out.Steps[0].ActiveAttempt = 1
	return Result{
		Workflow: out,
		Effects:  []Effect{audit("STEP_ISSUED", out.Steps[0].Type, 1)},
	}, nil
}

// ApplyResult is the engine ingress for an inbound participant result. It
// performs the §5 classification in fixed order and, only when it yields
// APPLIED, fires the corresponding transition. Non-APPLIED classifications
// mutate nothing (§3.7/3.8/3.9). knownEvent reports whether event_id is already
// in processed_events (the DUPLICATE check the store owns).
func ApplyResult(wf Workflow, ev ResultEvent, knownEvent bool, now time.Time) (Result, error) {
	out := wf.clone()

	// 1. DUPLICATE — byte-identical redelivery.
	if knownEvent {
		return noChange(out, ClassDuplicate, audit("RESULT_DUPLICATE", ev.StepType, ev.Attempt)), nil
	}
	// 2. TERMINAL_IGNORED — the DS-1 closure. A completed/failed/aborted
	//    workflow is never reopened or downgraded, no matter how fresh the
	//    re-authored event looks.
	if out.State.IsTerminal() {
		return noChange(out, ClassTerminalIgnored, audit("TERMINAL_IGNORED", ev.StepType, ev.Attempt)), nil
	}

	// 3/4. Determine the step we are currently waiting on and classify.
	waiting := out.waitingStep()
	if waiting == nil || ev.StepType != waiting.Type {
		// Names nothing we are waiting for.
		st := out.stepByType(ev.StepType)
		if st == nil || st.State == StepPending {
			// Unknown step_type or a step not yet started: nothing to answer.
			return noChange(out, ClassUnsolicited, audit("RESULT_UNSOLICITED", ev.StepType, ev.Attempt)), nil
		}
		// A real but already-settled / superseded step: stale.
		return noChange(out, ClassStale, audit("RESULT_STALE", ev.StepType, ev.Attempt)), nil
	}
	// 4b. Correct step but an obsolete attempt (fencing) -> STALE.
	if ev.Attempt < waiting.ActiveAttempt {
		return noChange(out, ClassStale, audit("RESULT_STALE_ATTEMPT", ev.StepType, ev.Attempt)), nil
	}
	// 5. APPLIED. Enforce optimistic concurrency before mutating anything.
	if err := guard(&out, ev.ExpectedVersion); err != nil {
		return Result{}, err
	}
	out.record(ev.EventID)

	var res Result
	var err error
	if waiting.State == StepCompensating || waiting.State == StepCompensationPending {
		res, err = applyCompensationResult(out, waiting, ev, now)
	} else {
		res, err = applyForwardResult(out, waiting, ev, now)
	}
	if err != nil {
		return Result{}, err
	}
	res.Classification = ClassApplied
	return res, nil
}

// applyForwardResult handles a result for a forward (non-compensation) step.
func applyForwardResult(out Workflow, st *Step, ev ResultEvent, now time.Time) (Result, error) {
	if ev.Outcome == OutcomeSucceeded {
		st.State = StepSucceeded
		out.bump()
		if out.State == StateCancelling {
			// §10: forward edges are disabled while CANCELLING. The in-flight
			// success is recorded, then the workflow winds down (compensate
			// completed -> ABORTED, or FAILED if nothing completed). Never COMPLETED.
			return beginTermination(out, st.Type, ev.Attempt), nil
		}
		if next := out.nextPending(); next != nil {
			// W3: succeed, more steps remain — issue next in same tx.
			next.State = StepIssued
			next.ActiveAttempt = 1
			return Result{Workflow: out, Effects: []Effect{
				audit("STEP_SUCCEEDED", st.Type, ev.Attempt),
				command(next.Type, 1, "STEP_ISSUED"),
			}}, nil
		}
		// W9: final step succeeded -> COMPLETED (terminal, immutable).
		out.State = StateCompleted
		return Result{Workflow: out, Effects: []Effect{
			audit("STEP_SUCCEEDED", st.Type, ev.Attempt),
			audit("WORKFLOW_COMPLETED", "", -1),
		}}, nil
	}

	// Failed result.
	st.State = StepFailed
	out.bump()
	if out.State == StateCancelling {
		// Winding down: no new forward attempts while cancelling.
		return beginTermination(out, st.Type, ev.Attempt), nil
	}
	max := st.MaxAttempts
	if max <= 0 {
		max = 1
	}
	retryable := ev.ErrorClass == ErrRetryable || (ev.ErrorClass == ErrUnknown && st.ActiveAttempt < 2)
	if retryable && st.ActiveAttempt < max {
		// W5: retryable, budget left -> RETRY_WAITING with a durable schedule.
		out.State = StateRetryWaiting
		return Result{
			Workflow:      out,
			NextAttemptAt: now.Add(backoff(st.ActiveAttempt)),
			Effects:       []Effect{audit("RETRY_SCHEDULED", st.Type, st.ActiveAttempt)},
		}, nil
	}
	// Permanent failure -> compensate completed steps (W7) or FAILED (W8).
	return beginTermination(out, st.Type, ev.Attempt), nil
}

// beginTermination implements the W7/W8 fork shared by permanent failure,
// timeout exhaustion, and used from Retry when a budget finally runs out.
func beginTermination(out Workflow, failedStepType string, attempt int) Result {
	set := out.completedCompensable()
	if len(set) == 0 {
		// W8: nothing to compensate -> FAILED terminal.
		out.State = StateFailed
		return Result{Workflow: out, Effects: []Effect{
			audit("WORKFLOW_FAILED", failedStepType, attempt),
		}}
	}
	// W7: begin compensation in reverse order over completed steps.
	out.State = StateCompensating
	first := set[0]
	first.State = StepCompensating
	effects := []Effect{
		audit("COMPENSATION_STARTED", first.Type, first.ActiveAttempt),
		compensate(first.Type, first.ActiveAttempt, "COMPENSATION_ISSUED"),
	}
	return Result{Workflow: out, Effects: effects}
}

// applyCompensationResult handles a result for a compensator (COMPENSATING).
func applyCompensationResult(out Workflow, st *Step, ev ResultEvent, now time.Time) (Result, error) {
	if ev.Outcome == OutcomeSucceeded {
		st.State = StepCompensated
		out.bump()
		if next := out.nextCompensating(); next != nil {
			// W10: a compensator succeeded, more remain.
			next.State = StepCompensating
			return Result{Workflow: out, Effects: []Effect{
				audit("STEP_COMPENSATED", st.Type, st.ActiveAttempt),
				compensate(next.Type, next.ActiveAttempt, "COMPENSATION_ISSUED"),
			}}, nil
		}
		// W11: last compensator succeeded -> ABORTED (terminal, rolled back).
		out.State = StateAborted
		return Result{Workflow: out, Effects: []Effect{
			audit("STEP_COMPENSATED", st.Type, st.ActiveAttempt),
			audit("WORKFLOW_ABORTED", "", -1),
		}}, nil
	}
	// Compensator failed terminally -> W12 FAILED_MANUAL + dead-letter intent.
	st.State = StepCompensationFailed
	out.State = StateFailedManual
	out.bump()
	return Result{Workflow: out, Effects: []Effect{
		audit("COMPENSATION_FAILED", st.Type, st.ActiveAttempt),
		{Kind: EffectDeadLetter, ReasonCode: "COMPENSATION", StepType: st.Type, Attempt: st.ActiveAttempt},
	}}, nil
}

// Retry drives W6 (RETRY_WAITING -> RUNNING) when the durable due-time is
// reached. It creates the next attempt (the fencing token) and re-issues the
// command. The scheduler loop that *decides* to call this is the reaper
// (a later phase); this pure function is the transition itself.
func Retry(wf Workflow, expectedVersion int64, now time.Time) (Result, error) {
	out := wf.clone()
	if err := guard(&out, expectedVersion); err != nil {
		return Result{}, err
	}
	if out.State != StateRetryWaiting {
		return Result{}, InvalidTransitionError{From: out.State, Reason: "retry requires RETRY_WAITING"}
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
		audit("ATTEMPT_ISSUED", st.Type, st.ActiveAttempt),
		command(st.Type, st.ActiveAttempt, "STEP_REISSUED"),
	}}, nil
}

// TimeoutStep is the engine-side response-deadline outcome (§8 forward timeout).
// It behaves like a RETRYABLE failure for the current attempt: W5 with budget,
// otherwise the W7/W8 termination fork.
func TimeoutStep(wf Workflow, stepType string, expectedVersion int64, now time.Time) (Result, error) {
	out := wf.clone()
	if out.State.IsTerminal() {
		return Result{}, TerminalImmutableError{WorkflowID: out.ID, State: out.State}
	}
	if err := guard(&out, expectedVersion); err != nil {
		return Result{}, err
	}
	st := out.stepByType(stepType)
	if st == nil || (st.State != StepIssued && st.State != StepInProgress) {
		return noChange(out, ClassUnsolicited, audit("TIMEOUT_UNSOLICITED", stepType, 0)), nil
	}
	st.State = StepTimedOut
	out.bump()
	if out.State == StateCancelling {
		// Winding down: no new forward attempts while cancelling. The table has
		// no CANCELLING -> RETRY_WAITING edge, and a retry re-issued here would
		// fight the cancel (same rule applyForwardResult enforces for failures).
		return beginTermination(out, st.Type, st.ActiveAttempt), nil
	}
	max := st.MaxAttempts
	if max <= 0 {
		max = 1
	}
	if st.ActiveAttempt < max {
		out.State = StateRetryWaiting
		return Result{Workflow: out, NextAttemptAt: now.Add(backoff(st.ActiveAttempt)),
			Effects: []Effect{audit("RETRY_SCHEDULED_TIMEOUT", st.Type, st.ActiveAttempt)}}, nil
	}
	term := beginTermination(out, st.Type, st.ActiveAttempt)
	return term, nil
}

// Cancel applies the W14/W14b edges. Cancel while COMPENSATING is rejected
// (already unwinding); cancel of a terminal workflow is refused.
func Cancel(wf Workflow, expectedVersion int64) (Result, error) {
	out := wf.clone()
	if out.State.IsTerminal() {
		return Result{}, TerminalImmutableError{WorkflowID: out.ID, State: out.State}
	}
	if err := guard(&out, expectedVersion); err != nil {
		return Result{}, err
	}
	switch out.State {
	case StateQueued:
		// W14: nothing ran -> FAILED terminal.
		out.State = StateFailed
		out.bump()
		return Result{Workflow: out, Effects: []Effect{audit("WORKFLOW_CANCELLED", "", -1)}}, nil
	case StateRunning, StateRetryWaiting:
		// W14b: accepted; in-flight attempt is not killed, winding down.
		out.State = StateCancelling
		out.bump()
		return Result{Workflow: out, Effects: []Effect{audit("CANCEL_ACCEPTED", "", -1)}}, nil
	default:
		return Result{}, InvalidTransitionError{From: out.State, Reason: "not cancellable"}
	}
}

// ---- helpers ---------------------------------------------------------------

// guard enforces optimistic concurrency (REQ-C-3): the expected version must
// match the current version or the write is a losing race.
func guard(out *Workflow, expectedVersion int64) error {
	if expectedVersion != out.Version {
		return StaleVersionError{WorkflowID: out.ID, Expected: expectedVersion, Actual: out.Version}
	}
	return nil
}

// waitingStep returns the step the engine is currently expecting a result for:
// a forward ISSUED/IN_PROGRESS step, or the active COMPENSATING step. It also
// handles CANCELLING, where a single in-flight forward step is still awaited.
func (w *Workflow) waitingStep() *Step {
	if s := w.activeStep(); s != nil {
		return s
	}
	for i := range w.Steps {
		st := &w.Steps[i]
		if st.State == StepCompensating || st.State == StepCompensationPending {
			return st
		}
	}
	return nil
}

// nextCompensating returns the not-yet-compensated completed compensable step
// with the HIGHEST position, so compensation proceeds in strict reverse
// declaration order over the completed set (§1). Only called while COMPENSATING.
func (w *Workflow) nextCompensating() *Step {
	var chosen *Step
	for i := range w.Steps {
		st := &w.Steps[i]
		if st.Compensable && st.State == StepSucceeded {
			if chosen == nil || st.Position > chosen.Position {
				chosen = st
			}
		}
	}
	return chosen
}

// stepAwaitingRetry returns the forward step that is waiting for its next
// attempt. W5 is entered by BOTH a retryable failure (FAILED) and a response
// timeout (TIMED_OUT, SM §8: "reaper -> W5/W7"), so both states await W6 —
// matching only FAILED would strand every timed-out RETRY_WAITING workflow
// (latent Phase-4 gap, regression-tested in recovery_test.go).
func (w *Workflow) stepAwaitingRetry() *Step {
	for i := range w.Steps {
		if s := &w.Steps[i]; s.State == StepFailed || s.State == StepTimedOut {
			return s
		}
	}
	return nil
}

func (w *Workflow) clone() Workflow {
	c := *w
	c.Steps = make([]Step, len(w.Steps))
	copy(c.Steps, w.Steps)
	return c
}

func (w *Workflow) bump() { w.Version++ }

// record is a hook the store uses to note the processed event id; the pure
// machine does not keep the ledger (processed_events is the store's), so this
// is intentionally a no-op marker kept for clarity/extension.
func (w *Workflow) record(_ string) {}

func noChange(out Workflow, c Classification, e Effect) Result {
	return Result{Classification: c, Workflow: out, Effects: []Effect{e}}
}

func audit(reasonCode, stepType string, attempt int) Effect {
	return Effect{Kind: EffectAudit, ReasonCode: reasonCode, StepType: stepType, Attempt: attempt}
}

func command(stepType string, attempt int, reasonCode string) Effect {
	return Effect{Kind: EffectOutbox, ReasonCode: reasonCode, StepType: stepType, Attempt: attempt, IsCommand: true}
}

func compensate(stepType string, attempt int, reasonCode string) Effect {
	return Effect{Kind: EffectOutbox, ReasonCode: reasonCode, StepType: stepType, Attempt: attempt, IsCommand: true, IsCompensation: true}
}

// backoff is the normative base schedule (2s x 2^(n-1), capped 60s). Full
// jitter is applied by the reaper at W6, not here, to keep this pure function
// deterministic.
func backoff(attempt int) time.Duration {
	const base = 2 * time.Second
	const cap = 60 * time.Second
	if attempt < 1 {
		attempt = 1
	}
	d := base
	for i := 1; i < attempt; i++ {
		d *= 2
		if d >= cap {
			return cap
		}
	}
	if d > cap {
		return cap
	}
	return d
}

// Backoff exposes the normative base retry schedule (SM §8: 2s x 2^(n-1),
// capped 60s) so the reaper — the specified applier of full jitter at W6 —
// jitters against the same numbers the machine used to schedule the due time,
// without any caller re-deriving the schedule privately.
func Backoff(attempt int) time.Duration { return backoff(attempt) }
