// Package engine is Fathom's pure workflow state machine.
//
// It is the single source of truth for engine semantics, implementing the
// transition table in docs/WORKFLOW_STATE_MACHINE.md as a deterministic
// function over an in-memory snapshot. It performs no I/O: it does not touch
// PostgreSQL, Kafka, clocks (time is passed in), or transport. Persistence and
// the reaper scheduler live in other packages and call into here.
//
// The central design rule that closes the audited repo's DS-1 defect (a
// replayed event silently moving COMPLETED -> ABORTED): status is stored per
// entity and changed only by an enumerated transition. Nothing is ever
// re-derived from collected values, and terminal states have no outbound edge.
//
// Guarantees this package provides are exactly those in WORKFLOW_STATE_MACHINE
// §9. It does NOT claim exactly-once processing: an event is always read,
// stored and classified; the guarantee is that a non-APPLIED classification has
// zero state effect and that at most one APPLIED transition per (step, attempt)
// mutates state.
package engine

import "time"

// WorkflowState is the persisted state of a workflow instance. The set of
// values is normative (WORKFLOW_STATE_MACHINE §2); the CHECK constraint in the
// schema mirrors it.
type WorkflowState string

const (
	StateQueued       WorkflowState = "QUEUED"
	StateRunning      WorkflowState = "RUNNING"
	StateRetryWaiting WorkflowState = "RETRY_WAITING"
	StateCompensating WorkflowState = "COMPENSATING"
	StateCancelling   WorkflowState = "CANCELLING"
	StateCompleted    WorkflowState = "COMPLETED"
	StateFailed       WorkflowState = "FAILED"
	StateAborted      WorkflowState = "ABORTED"
	StateFailedManual WorkflowState = "FAILED_MANUAL"
)

// IsTerminal reports whether s is an immutable terminal state (REQ-C-1).
// FAILED_MANUAL is deliberately NOT terminal: it is inert (no automatic event
// advances it) but an authorized operator action may still resolve it.
func (s WorkflowState) IsTerminal() bool {
	switch s {
	case StateCompleted, StateFailed, StateAborted:
		return true
	default:
		return false
	}
}

// StepState is the persisted state of a single workflow step (§3).
type StepState string

const (
	StepPending             StepState = "PENDING"
	StepIssued              StepState = "ISSUED"
	StepInProgress          StepState = "IN_PROGRESS"
	StepSucceeded           StepState = "SUCCEEDED"
	StepFailed              StepState = "FAILED"
	StepTimedOut            StepState = "TIMED_OUT"
	StepCompensationPending StepState = "COMPENSATION_PENDING"
	StepCompensating        StepState = "COMPENSATING"
	StepCompensated         StepState = "COMPENSATED"
	StepCompensationFailed  StepState = "COMPENSATION_FAILED"
)

// Outcome is a step result's terminal disposition as reported by a participant.
type Outcome string

const (
	OutcomeSucceeded Outcome = "SUCCEEDED"
	OutcomeFailed    Outcome = "FAILED"
)

// ErrorClass classifies a failed result. Engine retries RETRYABLE; TERMINAL
// never retries; UNKNOWN retries exactly once then goes terminal (§E rule), so
// a runaway retry loop is impossible.
type ErrorClass string

const (
	ErrRetryable ErrorClass = "RETRYABLE"
	ErrTerminal  ErrorClass = "TERMINAL"
	ErrUnknown   ErrorClass = "UNKNOWN"
)

// Classification is the ingress verdict for an inbound result event, evaluated
// in the fixed order of §5. It is persisted on inbound_event.
type Classification string

const (
	ClassDuplicate       Classification = "DUPLICATE"
	ClassTerminalIgnored Classification = "TERMINAL_IGNORED"
	ClassUnsolicited     Classification = "UNSOLICITED"
	ClassStale           Classification = "STALE"
	ClassApplied         Classification = "APPLIED"
	ClassUnparseable     Classification = "UNPARSEABLE"
)

// EffectKind names an action a transition must carry out in the SAME database
// transaction (audit row, outbox publish intent, dead-letter intent). Keeping
// these as data (not side effects executed here) is what lets the store commit
// state + history + outbox atomically and lets tests assert on them.
type EffectKind string

const (
	EffectAudit      EffectKind = "AUDIT"
	EffectOutbox     EffectKind = "OUTBOX"
	EffectDeadLetter EffectKind = "DEAD_LETTER"
)

// Effect is one durable side effect described by a transition.
type Effect struct {
	Kind       EffectKind
	ReasonCode string // machine-readable; carried into audit_event.reason_code
	StepType   string // empty for workflow-level effects
	Attempt    int    // -1 when not attempt-scoped
	// CommandIssued marks an outbox intent to issue a forward command for
	// StepType at Attempt (used by the store to build the command envelope).
	IsCommand bool
	// IsCompensation distinguishes a compensator command from a forward one.
	IsCompensation bool
}

// Workflow is the in-memory snapshot the machine reasons over. The store loads
// it from the workflow + step rows, hands it to a transition function, and
// persists the returned snapshot under a version guard.
type Workflow struct {
	ID      string
	State   WorkflowState
	Version int64
	Steps   []Step
}

// Step is one declared step. Position is declaration order (0-based); forward
// execution proceeds in increasing Position, compensation in decreasing
// Position over SUCCEEDED steps that have a compensator.
type Step struct {
	Type          string
	Position      int
	State         StepState
	ActiveAttempt int
	MaxAttempts   int  // retry budget (guard on W5); <=0 means "1"
	Compensable   bool // declares a compensator task
}

// activeStep returns the step the engine is currently expecting a result for,
// or nil when none is active (workflow not running, or between steps).
func (w *Workflow) activeStep() *Step {
	for i := range w.Steps {
		st := &w.Steps[i]
		if st.State == StepIssued || st.State == StepInProgress {
			return st
		}
	}
	return nil
}

// stepByType returns the named step or nil.
func (w *Workflow) stepByType(t string) *Step {
	for i := range w.Steps {
		if w.Steps[i].Type == t {
			return &w.Steps[i]
		}
	}
	return nil
}

// nextPending returns the next PENDING step in declaration order.
func (w *Workflow) nextPending() *Step {
	for i := range w.Steps { // declaration order == slice order
		if w.Steps[i].State == StepPending {
			return &w.Steps[i]
		}
	}
	return nil
}

// completedCompensable returns SUCCEEDED steps that declare a compensator, in
// reverse order (the compensation set, per §1 "reverse order over completed
// steps only").
func (w *Workflow) completedCompensable() []*Step {
	var out []*Step
	for i := len(w.Steps) - 1; i >= 0; i-- {
		st := &w.Steps[i]
		if st.Compensable && (st.State == StepSucceeded ||
			st.State == StepCompensationPending || st.State == StepCompensating) {
			out = append(out, st)
		}
	}
	return out
}

// ResultEvent is an inbound participant result (DATA §E), reduced to the
// identity + outcome fields the machine reasons about. ExpectedVersion is the
// workflow version the reader observed; a mismatch is rejected as stale.
// TraceID (32-hex, from the envelope's traceparent) is not reasoned about by
// the machine — it rides the struct so the store stamps it onto audit rows and
// the command envelopes the transition emits, keeping one trace per workflow
// run (REQ-OP-6).
type ResultEvent struct {
	EventID         string
	WorkflowID      string
	StepType        string
	Attempt         int
	Outcome         Outcome
	ErrorClass      ErrorClass
	ExpectedVersion int64
	TraceID         string
}

// Result is the outcome of applying an event: the classification, the new
// snapshot (equal to the input when no transition fired), and the effects the
// store must persist atomically.
type Result struct {
	Classification Classification
	Workflow       Workflow
	Effects        []Effect
	// NextAttemptAt is set on a RETRY_WAITING transition so the caller can
	// persist the durable retry schedule (base backoff, no jitter — the reaper
	// applies jitter when it drives W6).
	NextAttemptAt time.Time
}
