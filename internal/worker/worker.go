// Package worker executes claimed participant work against the durable store
// (Phase-5 brief §2/§3). The rules this loop honors:
//
//   - claim → execute → submit are three separate transactions; nothing is
//     held open across handler execution (no transaction spans business work);
//   - the lease is heartbeated while the handler runs; losing the lease
//     cancels the handler context — the worker stops cooperating — and any
//     result it still produces is refused by the store's lease gate, not by
//     this loop's memory;
//   - submissions that lose the version race are re-read and re-submitted a
//     bounded number of times; a result that still cannot land is left to
//     expiry + reclaim, which is the documented recovery path, not a silence.
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/Lakhyajit-96/fathom/internal/engine"
	"github.com/Lakhyajit-96/fathom/internal/id"
	"github.com/Lakhyajit-96/fathom/internal/participant"
	postgres "github.com/Lakhyajit-96/fathom/internal/store/postgres"
	"github.com/Lakhyajit-96/fathom/internal/tracing"
)

// Config tunes the loop. Zero values select the documented defaults.
type Config struct {
	ID                string        // worker identity for leases; generated if empty
	LeaseTTL          time.Duration // claim lease duration (SM §8: 90s)
	PollInterval      time.Duration // idle wait between empty claims
	HeartbeatInterval time.Duration // lease renewal cadence (TTL/3 default)
	MaxSubmitTries    int           // version-conflict resubmits per result
	ExecTimeout       time.Duration // hard cap per handler (0 => lease-only)
}

func (c *Config) withDefaults() error {
	if c.ID == "" {
		c.ID = "worker-" + id.New()
	}
	if c.LeaseTTL <= 0 {
		c.LeaseTTL = postgres.DefaultLeaseTTL
	}
	if c.PollInterval <= 0 {
		c.PollInterval = 250 * time.Millisecond
	}
	if c.HeartbeatInterval <= 0 {
		c.HeartbeatInterval = c.LeaseTTL / 3
	}
	if c.HeartbeatInterval >= c.LeaseTTL {
		return fmt.Errorf("worker: heartbeat %v must be < lease TTL %v", c.HeartbeatInterval, c.LeaseTTL)
	}
	if c.MaxSubmitTries <= 0 {
		c.MaxSubmitTries = 3
	}
	return nil
}

// Worker is one execution loop over the shared store.
type Worker struct {
	store    *postgres.Store
	registry *participant.Registry
	cfg      Config
	log      *slog.Logger

	cancel context.CancelFunc
	done   chan struct{}
}

// New validates config and returns an unstarted worker.
func New(store *postgres.Store, registry *participant.Registry, cfg Config, log *slog.Logger) (*Worker, error) {
	if store == nil || registry == nil {
		return nil, errors.New("worker: store and registry required")
	}
	if err := cfg.withDefaults(); err != nil {
		return nil, err
	}
	if log == nil {
		log = slog.Default()
	}
	return &Worker{store: store, registry: registry, cfg: cfg, log: log.With("component", "worker", "id", cfg.ID)}, nil
}

// Start launches the claim loop on the process lifetime ctx.
func (w *Worker) Start(ctx context.Context) {
	runCtx, cancel := context.WithCancel(ctx)
	w.cancel = cancel
	w.done = make(chan struct{})
	go func() {
		defer close(w.done)
		w.loop(runCtx)
	}()
	w.log.Info("worker started", "lease_ttl", w.cfg.LeaseTTL.String(), "tasks", w.registry.Tasks())
}

// Name implements app.Component.
func (w *Worker) Name() string { return "worker" }

// Shutdown stops claiming, lets the in-flight handler finish (its lease keeps
// being renewed while it runs), and returns. Cancelling the loop ctx also
// cancels any handler still executing: at-least-once means an interrupted
// attempt is simply reclaimed and re-run later, not awaited indefinitely.
func (w *Worker) Shutdown(ctx context.Context) error {
	if w.cancel != nil {
		w.cancel()
	}
	if w.done == nil {
		return nil
	}
	select {
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *Worker) loop(ctx context.Context) {
	for ctx.Err() == nil {
		claim, ok, err := w.store.ClaimStep(ctx, w.cfg.ID, w.cfg.LeaseTTL)
		if err != nil {
			if ctx.Err() == nil {
				w.log.Error("claim failed", "err", err)
			}
			w.sleep(ctx, w.cfg.PollInterval*4) // back off away from a failing store
			continue
		}
		if !ok {
			w.sleep(ctx, w.cfg.PollInterval)
			continue
		}
		w.handle(ctx, claim)
	}
}

func (w *Worker) sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// handle executes one claim under a heartbeated lease and submits the result.
func (w *Worker) handle(parent context.Context, c postgres.Claim) {
	w.log.Info("claimed", "workflow", c.WorkflowID, "step", c.StepType,
		"attempt", c.Attempt, "task", c.Task, "compensation", c.Compensation)

	// Task context: cancelled when the heartbeat proves displacement, or on
	// shutdown, or after ExecTimeout — the handler cannot outrun its lease.
	execCtx, cancelExec := context.WithCancel(parent)
	defer cancelExec()
	if w.cfg.ExecTimeout > 0 {
		tctx, cancelTimeout := context.WithTimeout(execCtx, w.cfg.ExecTimeout)
		defer cancelTimeout()
		execCtx = tctx
	}
	go func() {
		ticker := time.NewTicker(w.cfg.HeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-execCtx.Done():
				return
			case <-ticker.C:
				alive, err := w.store.RenewLease(parent, c.WorkflowID, c.StepType, w.cfg.ID, w.cfg.LeaseTTL)
				if err != nil {
					// A transient store fault is not displacement: keep going,
					// the next beat re-checks. The lease itself is the truth.
					w.log.Warn("heartbeat renew failed", "err", err)
					continue
				}
				if !alive {
					w.log.Warn("lease lost mid-execution; cancelling handler",
						"workflow", c.WorkflowID, "step", c.StepType, "attempt", c.Attempt)
					cancelExec()
					return
				}
			}
		}
	}()

	task, err := w.buildTask(parent, c)
	if err != nil {
		if parent.Err() != nil {
			return // shutdown: the lease simply expires
		}
		w.log.Error("load task context failed", "err", err)
		return
	}

	var outcome engine.Outcome
	var class engine.ErrorClass
	var output json.RawMessage
	h, ok := w.registry.Handler(c.Task)
	if !ok {
		// Misconfiguration is surfaced as a real terminal result, never
		// swallowed: the engine records the failure the workflow actually has.
		w.log.Error("no handler registered for task", "task", c.Task)
		outcome, class = engine.OutcomeFailed, engine.ErrTerminal
	} else {
		output, err = h.Execute(execCtx, task)
		switch {
		case err == nil:
			outcome = engine.OutcomeSucceeded
		case errors.Is(err, context.Canceled) && execCtx.Err() != nil && parent.Err() == nil:
			// Displacement cancel: submit nothing; the reclaim path re-runs it.
			w.log.Info("execution abandoned (lease lost)", "workflow", c.WorkflowID, "step", c.StepType)
			return
		default:
			outcome = engine.OutcomeFailed
			class = mapClass(participant.ClassOf(err))
			w.log.Warn("handler failed", "workflow", c.WorkflowID, "step", c.StepType,
				"attempt", c.Attempt, "class", string(class), "err", err)
		}
	}
	w.submit(parent, c, task.Traceparent, outcome, class, output)
}

func (w *Worker) buildTask(ctx context.Context, c postgres.Claim) (participant.Task, error) {
	detail, err := w.store.GetWorkflowDetail(ctx, c.WorkflowID)
	if err != nil {
		return participant.Task{}, err
	}
	tp, err := w.store.CommandTraceparent(ctx, c.WorkflowID, c.StepType, c.Attempt)
	if err != nil {
		w.log.Warn("command traceparent unavailable; result will mint its own", "err", err)
		tp = ""
	}
	return participant.Task{
		WorkflowID: c.WorkflowID, StepType: c.StepType, Task: c.Task,
		Attempt: c.Attempt, Compensation: c.Compensation,
		Input: detail.Input, Traceparent: tp,
	}, nil
}

func mapClass(pc participant.Class) engine.ErrorClass {
	switch pc {
	case participant.ClassRetryable:
		return engine.ErrRetryable
	case participant.ClassPermanent:
		return engine.ErrTerminal
	default:
		return engine.ErrUnknown
	}
}

// submit writes one result envelope through the lease-gated ingress, re-reading
// the version on optimistic conflicts (a concurrent scheduler transition is
// legitimate; the result must still be recorded — ignored != invisible).
func (w *Worker) submit(ctx context.Context, c postgres.Claim, taskTP string, outcome engine.Outcome, class engine.ErrorClass, output json.RawMessage) {
	eventID := id.New()
	for try := 1; try <= w.cfg.MaxSubmitTries; try++ {
		if ctx.Err() != nil {
			return
		}
		loaded, err := w.store.LoadWorkflow(ctx, c.WorkflowID)
		if err != nil {
			w.log.Error("read for submit failed", "err", err)
			w.sleep(ctx, w.cfg.PollInterval)
			continue
		}
		tp := tracing.NewTraceparent()
		if taskTP != "" {
			tp = taskTP // continue the trace the command started (REQ-OP-6)
		}
		ev := engine.ResultEvent{
			EventID: eventID, WorkflowID: c.WorkflowID, StepType: c.StepType,
			Attempt: c.Attempt, Outcome: outcome, ErrorClass: class,
			ExpectedVersion: loaded.Version, TraceID: tracing.TraceID(tp),
		}
		raw := resultEnvelope(eventID, tp, w.cfg.ID, ev, output)
		class2, err := w.store.SubmitResult(ctx, ev, raw, w.cfg.ID)
		if err != nil {
			var ce postgres.ConflictError
			if errors.As(err, &ce) && ce.Retryable() {
				continue // version moved under us; re-read and re-submit
			}
			w.log.Error("submit failed", "err", err, "workflow", c.WorkflowID, "step", c.StepType)
			return
		}
		switch class2 {
		case engine.ClassApplied:
			w.log.Info("result applied", "workflow", c.WorkflowID, "step", c.StepType, "attempt", c.Attempt)
		default:
			w.log.Warn("result classified without effect", "workflow", c.WorkflowID,
				"step", c.StepType, "attempt", c.Attempt, "classification", string(class2))
		}
		return
	}
	w.log.Error("giving up submit after retries; lease expiry + reclaim will recover this attempt",
		"workflow", c.WorkflowID, "step", c.StepType, "attempt", c.Attempt)
}

// resultEnvelope builds the DATA §E inbound envelope the store records
// verbatim in inbound_event.raw — the same document a remote participant would
// publish, so the audit trail is identical in-process and over Kafka.
func resultEnvelope(eventID, traceparent, source string, ev engine.ResultEvent, output json.RawMessage) []byte {
	env := map[string]any{
		"specversion":     "1.0",
		"id":              eventID,
		"source":          source,
		"type":            "fathom.step.result.v1",
		"time":            time.Now().UTC().Format(time.RFC3339Nano),
		"subject":         ev.WorkflowID,
		"workflow_id":     ev.WorkflowID,
		"step_type":       ev.StepType,
		"attempt":         ev.Attempt,
		"traceparent":     traceparent,
		"datacontenttype": "application/json",
		"data": map[string]any{
			"outcome":     string(ev.Outcome),
			"error_class": string(ev.ErrorClass),
			"output":      output,
		},
	}
	b, err := json.Marshal(env)
	if err != nil {
		// Same policy as the store's jsonb: a marshal failure here is a
		// programming bug, and panicking beats writing a corrupt envelope.
		panic("worker: marshal result envelope: " + err.Error())
	}
	return b
}
