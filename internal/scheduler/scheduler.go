// Package scheduler runs the durable recovery loops of the control plane
// (Phase-5 brief §4; SM §8, ADR-012 "deadlines are data"): start queued work,
// drive due retries, time out overdue responses, reclaim expired leases, and
// escalate breached workflow deadlines. Everything is database state — there
// are no in-memory timers as the source of truth. A restart loses nothing:
// the next tick re-scans and finds the same due rows.
//
// Multiple replicas may run this loop concurrently. Scans take no locks;
// every action is a version-guarded transition, so the loser of a race gets a
// typed ConflictError and moves on. Those races are normal operation and are
// logged at debug, never as errors (the same discipline the store documents).
package scheduler

import (
	"context"
	"errors"
	"hash/fnv"
	"log/slog"
	"time"

	"github.com/Lakhyajit-96/fathom/internal/engine"
	postgres "github.com/Lakhyajit-96/fathom/internal/store/postgres"
)

// Config bounds the loop. Zero values select the SM §8 defaults.
type Config struct {
	Tick       time.Duration // scan cadence
	Batch      int           // per-scan candidate cap
	JitterFrac func(id string, attempt int, window time.Duration) time.Duration
	// Clock is injectable for tests; nil uses time.Now. It decides only the
	// jitter gate (a scheduling nicety); durable due-ness itself is always
	// the database clock, so an injectable wall clock cannot corrupt it.
	Clock func() time.Time
}

func (c *Config) withDefaults() {
	if c.Tick <= 0 {
		c.Tick = 2 * time.Second
	}
	if c.Batch <= 0 {
		c.Batch = 50
	}
	if c.JitterFrac == nil {
		c.JitterFrac = FullJitter
	}
	if c.Clock == nil {
		c.Clock = time.Now
	}
}

// FullJitter is the default gate: a deterministic pseudo-random fraction of
// the backoff window per (workflow id, attempt), uniform-ish in [0, window).
// Deterministic-per-row is deliberate: every replica computes the SAME
// effective due time, so N reapers do not stampede the same row at the tick
// boundary, and a restart reproduces the schedule — no hidden state.
func FullJitter(id string, attempt int, window time.Duration) time.Duration {
	if window <= 0 {
		return 0
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(id))
	_, _ = h.Write([]byte{byte(attempt)})
	return time.Duration(h.Sum64() % uint64(window))
}

// Scheduler is one recovery loop over the shared store.
type Scheduler struct {
	store  *postgres.Store
	cfg    Config
	log    *slog.Logger
	cancel context.CancelFunc
	done   chan struct{}
}

func New(store *postgres.Store, cfg Config, log *slog.Logger) (*Scheduler, error) {
	if store == nil {
		return nil, errors.New("scheduler: store required")
	}
	cfg.withDefaults()
	if log == nil {
		log = slog.Default()
	}
	return &Scheduler{store: store, cfg: cfg, log: log.With("component", "scheduler")}, nil
}

// Start launches the tick loop.
func (s *Scheduler) Start(ctx context.Context) {
	runCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.done = make(chan struct{})
	go func() {
		defer close(s.done)
		ticker := time.NewTicker(s.cfg.Tick)
		defer ticker.Stop()
		s.tick(runCtx) // immediate first pass: restarts re-drive instantly
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				s.tick(runCtx)
			}
		}
	}()
	s.log.Info("scheduler started", "tick", s.cfg.Tick.String(), "batch", s.cfg.Batch)
}

// Name implements app.Component.
func (s *Scheduler) Name() string { return "scheduler" }

// Shutdown stops the loop; an in-flight pass finishes its current action set
// or observes ctx cancellation between candidates.
func (s *Scheduler) Shutdown(ctx context.Context) error {
	if s.cancel != nil {
		s.cancel()
	}
	if s.done == nil {
		return nil
	}
	select {
	case <-s.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// TickOnce exposes one pass for tests and manual drains.
func (s *Scheduler) TickOnce(ctx context.Context) { s.tick(ctx) }

func (s *Scheduler) tick(ctx context.Context) {
	s.scanQueued(ctx)
	s.scanRetries(ctx)
	s.scanOverdue(ctx)
	s.scanDeadlines(ctx)
}

func (s *Scheduler) scanQueued(ctx context.Context) {
	cands, err := s.store.ScanQueued(ctx, s.cfg.Batch)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Error("queued scan failed", "err", err)
		}
		return
	}
	for _, c := range cands {
		if ctx.Err() != nil {
			return
		}
		if _, err := s.store.Start(ctx, c.ID, c.Version); err != nil {
			s.logAttempt("start", c.ID, err)
		}
	}
}

func (s *Scheduler) scanRetries(ctx context.Context) {
	cands, err := s.store.ScanDueRetries(ctx, s.cfg.Batch)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Error("retry scan failed", "err", err)
		}
		return
	}
	now := s.cfg.Clock()
	for _, c := range cands {
		if ctx.Err() != nil {
			return
		}
		// Full jitter gate on top of the durable due time: delay driving W6
		// until now >= due + jitter(attempt). Skipping leaves the row due —
		// the next tick re-finds it and the SAME (id, attempt) computes the
		// SAME delay, so the gate is stable across replicas and restarts and
		// fires no later than due + window.
		if gate := s.cfg.JitterFrac(c.ID, c.Attempt, engine.Backoff(c.Attempt)); now.Before(c.DueAt.Add(gate)) {
			continue
		}
		if _, err := s.store.Retry(ctx, c.ID, c.Version); err != nil {
			s.logAttempt("retry", c.ID, err)
		}
	}
}

func (s *Scheduler) scanOverdue(ctx context.Context) {
	cands, err := s.store.ScanOverdueSteps(ctx, s.cfg.Batch)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Error("overdue scan failed", "err", err)
		}
		return
	}
	for _, c := range cands {
		if ctx.Err() != nil {
			return
		}
		var err error
		switch c.Kind {
		case postgres.OverdueLease:
			_, err = s.store.ReclaimLease(ctx, c.WorkflowID, c.StepType, c.Version)
		default:
			_, err = s.store.TimeoutStep(ctx, c.WorkflowID, c.StepType, c.Version)
		}
		if err != nil {
			s.logAttempt(string(c.Kind), c.WorkflowID, err)
		}
	}
}

func (s *Scheduler) scanDeadlines(ctx context.Context) {
	cands, err := s.store.ScanExpiredDeadlines(ctx, s.cfg.Batch)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Error("deadline scan failed", "err", err)
		}
		return
	}
	for _, c := range cands {
		if ctx.Err() != nil {
			return
		}
		if _, err := s.store.EscalateDeadline(ctx, c.ID, c.Version); err != nil {
			s.logAttempt("escalate", c.ID, err)
		}
	}
}

// logAttempt classes one candidate action's outcome. Lost races and
// already-handled rows are the normal concurrent result and never errors.
func (s *Scheduler) logAttempt(op, wfID string, err error) {
	var ce postgres.ConflictError
	if errors.As(err, &ce) {
		s.log.Debug("race lost (normal)", "op", op, "workflow", wfID)
		return
	}
	var it engine.InvalidTransitionError
	if errors.As(err, &it) {
		s.log.Debug("candidate stale (normal)", "op", op, "workflow", wfID, "reason", it.Error())
		return
	}
	var ti engine.TerminalImmutableError
	if errors.As(err, &ti) {
		s.log.Debug("terminal row (normal)", "op", op, "workflow", wfID)
		return
	}
	s.log.Error("scheduler action failed", "op", op, "workflow", wfID, "err", err)
}
