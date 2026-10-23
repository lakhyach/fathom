// Package participant defines the execution contract between the durable
// engine and the code that actually does step work (Phase-5 brief §3).
//
// The contract is deliberately small and honest about distribution:
//
//   - a handler is named by TASK (the definition's step type, or the declared
//     compensator task), so the same worker binary can host any subset of
//     participants and the engine never hard-codes domain logic;
//   - failures are CLASSIFIED by the participant, not guessed by the runtime:
//     Retryable means "the same input may succeed later" (transient),
//     Permanent means "this input will never succeed" (business refusal).
//     An unclassified error maps to UNKNOWN — the machine treats it per its
//     §5 rules and the audit shows it was the participant's silence, not the
//     runtime's invention;
//   - execution is at-least-once: a worker may run the same (workflow, step,
//     attempt) more than once after a crash/lease race. Participants MUST
//     dedupe by the command key (workflow_id, step_type, attempt) or expose a
//     reconciliation hook — the SM contract states this explicitly, and this
//     package makes the key available instead of pretending the problem away.
package participant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// Task is one unit of work handed to a Handler. Attempt is the fencing token
// from the durable claim: it only ever increases, so a participant that
// dedupes by (WorkflowID, StepType, Attempt) can also refuse work from a
// displaced older attempt by comparing against the highest it has seen.
type Task struct {
	WorkflowID   string
	StepType     string
	Task         string // registry key: step type (forward) or compensator task
	Attempt      int
	Compensation bool
	Input        json.RawMessage // workflow input as pinned at creation
	Traceparent  string          // W3C context of the command being answered
}

// CommandKey is the idempotency identity participants dedupe by (§4.4/§9:
// exactly-once EFFECT per command, at-least-once delivery).
func (t Task) CommandKey() string {
	return fmt.Sprintf("%s/%s/%d", t.WorkflowID, t.StepType, t.Attempt)
}

// Handler executes one task. A nil error means SUCCEEDED; the returned JSON
// (may be nil) is the step output carried in the result envelope. Any error
// must be wrapped by Retryable or Permanent to express its class; the runtime
// maps unclassified errors to UNKNOWN rather than inventing a classification.
type Handler interface {
	Execute(ctx context.Context, t Task) (output json.RawMessage, err error)
}

// The HandlerFunc adapter keeps test participants one-liners without losing
// the explicit classification wrappers.
type HandlerFunc func(ctx context.Context, t Task) (json.RawMessage, error)

func (f HandlerFunc) Execute(ctx context.Context, t Task) (json.RawMessage, error) {
	return f(ctx, t)
}

// Error classes carried by every participant failure the runtime accepts.
type Class string

const (
	// ClassRetryable: transient; the budget's next attempt is legitimate.
	ClassRetryable Class = "RETRYABLE"
	// ClassPermanent: business refusal; retrying the same input cannot help.
	ClassPermanent Class = "TERMINAL"
	// ClassUnknown: the participant did not classify. Recorded as such.
	ClassUnknown Class = "UNKNOWN"
)

// classified is the internal marker interface the wrappers below produce.
type classified interface {
	error
	Class() Class
}

// Retryable marks err as a transient participant failure.
func Retryable(err error) error { return wrapped{err, ClassRetryable} }

// Permanent marks err as a never-retryable participant failure.
func Permanent(err error) error { return wrapped{err, ClassPermanent} }

type wrapped struct {
	inner error
	class Class
}

func (w wrapped) Error() string { return w.inner.Error() }
func (w wrapped) Unwrap() error { return w.inner }
func (w wrapped) Class() Class  { return w.class }

// ClassOf extracts the participant's declared class, defaulting to UNKNOWN —
// the runtime never upgrades an unclassified error to retryable (or to
// permanent) on the participant's behalf.
func ClassOf(err error) Class {
	var c classified
	if errors.As(err, &c) {
		return c.Class()
	}
	return ClassUnknown
}

// Registry maps task names to handlers. Registration is explicit and closed
// after startup (a task with no handler is a configuration error surfaced as
// a Permanent failure result — the engine records the real outcome instead of
// the worker silently dropping the command).
type Registry struct {
	handlers map[string]Handler
}

func NewRegistry() *Registry { return &Registry{handlers: map[string]Handler{}} }

// Register binds a handler to a task name. Duplicate registration is a
// programming error and panics: silent override would route work to the wrong
// participant.
func (r *Registry) Register(task string, h Handler) {
	if task == "" || h == nil {
		panic("participant: Register requires a task name and a handler")
	}
	if _, dup := r.handlers[task]; dup {
		panic("participant: duplicate handler registration for task " + task)
	}
	r.handlers[task] = h
}

// Handler returns the registered handler for a task name.
func (r *Registry) Handler(task string) (Handler, bool) {
	h, ok := r.handlers[task]
	return h, ok
}

// Tasks lists the registered names (startup logging / readiness reporting).
func (r *Registry) Tasks() []string {
	out := make([]string, 0, len(r.handlers))
	for k := range r.handlers {
		out = append(out, k)
	}
	return out
}
