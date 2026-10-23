package engine

import "fmt"

// This file defines the machine's typed error vocabulary. Every rejection is a
// distinct, inspectable error so callers (and the store) can map them to the
// right outcome (conflict retry vs. invalid transition) without string
// matching. No illegal transition is ever silently converted to success (§3.9).

// InvalidTransitionError reports an event the transition table has no edge for.
type InvalidTransitionError struct {
	From   WorkflowState
	Reason string
}

func (e InvalidTransitionError) Error() string {
	return fmt.Sprintf("engine: illegal transition from %s: %s", e.From, e.Reason)
}

// StaleVersionError reports that an event carried an expected workflow version
// that is no longer current. The state is not mutated (§3.8). This is the
// optimistic-concurrency rejection the store also enforces in SQL.
type StaleVersionError struct {
	WorkflowID string
	Expected   int64
	Actual     int64
}

func (e StaleVersionError) Error() string {
	return fmt.Sprintf("engine: stale version for workflow %s: expected %d, actual %d",
		e.WorkflowID, e.Expected, e.Actual)
}

// TerminalImmutableError reports an attempt to mutate a terminal workflow. It
// is returned only when a caller bypasses classification and calls a transition
// directly; the normal Apply path records TERMINAL_IGNORED instead of erroring
// (§5), so this guards programmatic misuse (REQ-C-1).
type TerminalImmutableError struct {
	WorkflowID string
	State      WorkflowState
}

func (e TerminalImmutableError) Error() string {
	return fmt.Sprintf("engine: workflow %s is terminal (%s) and cannot be mutated",
		e.WorkflowID, e.State)
}

// UnknownStepError reports an event naming a step_type not present in the
// workflow's pinned definition.
type UnknownStepError struct {
	WorkflowID string
	StepType   string
}

func (e UnknownStepError) Error() string {
	return fmt.Sprintf("engine: workflow %s has no step %q", e.WorkflowID, e.StepType)
}
