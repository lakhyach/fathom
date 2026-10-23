package postgres

import (
	"fmt"
)

// This file defines the store's typed error vocabulary. The brief (§5) forbids
// collapsing every fault into "not found": a missing row, a lost concurrency
// race, an idempotency-key reuse, and a business-key clash are DISTINCT and
// each carries the data a caller needs to decide retry-vs-fail. DB faults are
// returned wrapped (never here), preserving DS-13's "500 stays 500".

// NotFoundError reports that a workflow row genuinely does not exist. It is
// never produced for a storage fault (see mapQueryErr/DS-13).
type NotFoundError struct{ WorkflowID string }

func (e NotFoundError) Error() string {
	return fmt.Sprintf("store: workflow %s not found", e.WorkflowID)
}

// ConflictError is a retryable optimistic-concurrency loss: another writer
// advanced the workflow version between the caller's read and write, so this
// write affected 0 rows. It carries the observed current version so the caller
// can re-read and re-decide (ADR-009, DS-4). It is NOT an invalid transition.
type ConflictError struct {
	WorkflowID  string
	Expected    int64
	Actual      int64
	terminalNow bool // the row moved to a terminal state under us
}

func (e ConflictError) Error() string {
	if e.terminalNow {
		return fmt.Sprintf("store: conflict on workflow %s: it is now terminal (expected version %d)", e.WorkflowID, e.Expected)
	}
	return fmt.Sprintf("store: conflict on workflow %s: expected version %d, actual %d", e.WorkflowID, e.Expected, e.Actual)
}

// Retryable reports whether re-issuing the operation (after re-reading) can
// make progress. A version race is retryable; a terminal wall is not.
func (e ConflictError) Retryable() bool { return !e.terminalNow }

// IdempotencyConflictError reports reuse of an Idempotency-Key with a different
// request fingerprint (DATA §D: 422 IDEMPOTENCY_CONFLICT). The first durable
// outcome stands; this request is rejected without creating a workflow.
type IdempotencyConflictError struct{ Key string }

func (e IdempotencyConflictError) Error() string {
	return fmt.Sprintf("store: idempotency key %q reused with a different request", e.Key)
}

// ActiveWorkflowError reports the business-key guard rejected a second active
// workflow for the same target (DATA §A.1 partial unique index; DS-8/DS-10).
// ExistingID is the conflicting active workflow, surfaced for the 409 body.
type ActiveWorkflowError struct {
	BusinessKey string
	ExistingID  string
}

func (e ActiveWorkflowError) Error() string {
	return fmt.Sprintf("store: an active workflow (%s) already exists for business key %q", e.ExistingID, e.BusinessKey)
}
