// Package relay is the default pure-Go pgoutbox delivery loop (ADR-006,
// brief §7): it drains the transactional outbox into whatever transport a
// deployment configures, with the engine's delivery discipline:
//
//   - claim → publish → ack are three separate steps; no database lock or
//     transaction is held across the publisher's network I/O (the store's
//     claim is a single statement, then COMMIT);
//   - at-least-once: a relay that crashes after publishing but before
//     acking loses nothing — its per-row claim lease expires and another
//     relay re-delivers the row. Duplicates are the documented cost, and
//     consumers dedupe by the stable event_id (DATA §D);
//   - a stale relay cannot ack: acks are owner-guarded in the store, so a
//     row re-claimed by a live relay is never marked published by the dead
//     holder (its ack affects 0 rows and the loop logs it, never hides it);
//   - per-row failure is bounded: the store backs off (2s·2^n, cap 60s)
//     and after MaxRetries files the RETRY_EXHAUSTED dead-letter. The loop
//     never re-buries a row itself.
//
// Ordering model, stated honestly: rows are claimed and produced in outbox
// seq order (commit order) within one batch; the partition key is
// workflow_id (ADR-010), so per-workflow broker ordering follows submission
// order. Two concurrent batches across instances can interleave ACROSS
// workflows — never within one, because a workflow's commands are causal
// (the next command exists only after the previous result lands) and any
// re-issue carries a higher attempt the consumer ledger already discriminates.
//
// Kafka/Debezium stay optional and separate (ADR-005/006/007): a Publisher
// is just an interface. The demo/CI default is a broker-less publisher;
// the franz-go publisher lives in its own package and is wired only when
// configured, so the product module needs neither CGO nor a cluster.
package relay

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/Lakhyajit-96/fathom/internal/id"
	postgres "github.com/Lakhyajit-96/fathom/internal/store/postgres"
)

// Publisher delivers a batch of claimed outbox rows. Returning nil means
// every row is durable at the transport. Returning *Partial means exactly
// the listed seqs failed; returning any other error means the whole batch
// failed. A publisher must not retain rows past the call.
type Publisher interface {
	Publish(ctx context.Context, rows []postgres.RelayRow) error
}

// Partial reports per-row publish failures (a transport that can answer
// per-record — e.g. franz-go per-partition errors — should use it; the loop
// acks the successes and backs off only the failures).
type Partial struct {
	Failed map[int64]error // outbox seq -> cause
	Err    error           // aggregate cause for logging
}

func (p *Partial) Error() string {
	return fmt.Sprintf("relay: partial publish failure (%d rows): %v", len(p.Failed), p.Err)
}

// Config bounds the loop. Zero values select the documented defaults.
type Config struct {
	ID           string        // relay identity for claims/checkpoint; generated if empty
	Batch        int           // rows per claim (default 100)
	LeaseTTL     time.Duration // per-row claim lease; must exceed worst-case publish time (default 30s)
	PollInterval time.Duration // idle wait after an empty claim (default 250ms)
	MaxRetries   int           // publish attempts per row before RETRY_EXHAUSTED (default 5)
}

func (c *Config) withDefaults() {
	if c.ID == "" {
		c.ID = "relay-" + id.New()
	}
	if c.Batch <= 0 {
		c.Batch = 100
	}
	if c.LeaseTTL <= 0 {
		c.LeaseTTL = 30 * time.Second
	}
	if c.PollInterval <= 0 {
		c.PollInterval = 250 * time.Millisecond
	}
	if c.MaxRetries <= 0 {
		c.MaxRetries = 5
	}
}

// Relay is one outbox drain loop over the shared store. Multiple instances
// run concurrently and safely: claims are owner-disjoint by SKIP LOCKED +
// lease, acks are owner-guarded.
type Relay struct {
	store  *postgres.Store
	pub    Publisher
	cfg    Config
	log    *slog.Logger
	cancel context.CancelFunc
	done   chan struct{}

	// Real-operation counters for the metrics surface (brief §8: only numbers
	// this loop actually performs).
	Published    atomic.Int64 // rows acked as delivered
	Redeliveries atomic.Int64 // acks that found the row no longer ours (stale owner)
	PublishFails atomic.Int64 // rows whose publish attempt failed
	Exhausted    atomic.Int64 // rows that hit RETRY_EXHAUSTED dead-lettering
}

// New validates inputs and returns an unstarted relay.
func New(store *postgres.Store, pub Publisher, cfg Config, log *slog.Logger) (*Relay, error) {
	if store == nil || pub == nil {
		return nil, errors.New("relay: store and publisher required")
	}
	cfg.withDefaults()
	if log == nil {
		log = slog.Default()
	}
	return &Relay{store: store, pub: pub, cfg: cfg, log: log.With("component", "relay", "id", cfg.ID)}, nil
}

// Start launches the drain loop on the process lifetime ctx.
func (r *Relay) Start(ctx context.Context) {
	runCtx, cancel := context.WithCancel(ctx)
	r.cancel = cancel
	r.done = make(chan struct{})
	go func() {
		defer close(r.done)
		for runCtx.Err() == nil {
			idle, err := r.DrainOnce(runCtx)
			if err != nil {
				if runCtx.Err() == nil {
					r.log.Error("drain pass failed", "err", err)
				}
			}
			if !idle {
				continue // rows existed: keep draining immediately
			}
			r.sleep(runCtx, r.cfg.PollInterval)
		}
	}()
	r.log.Info("relay started", "batch", r.cfg.Batch, "lease_ttl", r.cfg.LeaseTTL.String(), "max_retries", r.cfg.MaxRetries)
}

// Name implements app.Component.
func (r *Relay) Name() string { return "relay" }

// Shutdown stops the loop. An in-flight pass finishes its current claim
// bookkeeping or observes ctx cancellation; rows already published but not
// acked are simply re-delivered later — the documented at-least-once window.
func (r *Relay) Shutdown(ctx context.Context) error {
	if r.cancel != nil {
		r.cancel()
	}
	if r.done == nil {
		return nil
	}
	select {
	case <-r.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Relay) sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// DrainOnce runs one claim→publish→ack pass; reports whether the claim was
// empty. Exported for tests, manual drains, and a "run to current end" mode.
func (r *Relay) DrainOnce(ctx context.Context) (idle bool, err error) {
	rows, err := r.store.ClaimOutboxBatch(ctx, r.cfg.ID, r.cfg.Batch, r.cfg.LeaseTTL)
	if err != nil {
		if ctx.Err() != nil {
			return true, nil // shutdown mid-claim; nothing to log
		}
		return false, err
	}
	if len(rows) == 0 {
		return true, nil
	}

	publishErr := r.pub.Publish(ctx, rows)
	if publishErr == nil {
		r.ack(ctx, seqsOf(rows))
		return false, nil
	}
	if ctx.Err() != nil {
		// Interrupted mid-publish: leave the leases to expiry; they redeliver.
		return false, nil
	}

	var part *Partial
	if errors.As(publishErr, &part) && part != nil && len(part.Failed) > 0 {
		var ok []int64
		for _, row := range rows {
			if _, bad := part.Failed[row.Seq]; bad {
				r.recordFailure(ctx, row, part.Failed[row.Seq])
			} else {
				ok = append(ok, row.Seq)
			}
		}
		r.ack(ctx, ok)
		return false, nil
	}
	for _, row := range rows {
		r.recordFailure(ctx, row, publishErr)
	}
	return false, nil
}

func (r *Relay) ack(ctx context.Context, seqs []int64) {
	if len(seqs) == 0 {
		return
	}
	acked, err := r.store.AckPublished(ctx, r.cfg.ID, seqs)
	if err != nil {
		// Rows stay unpublished (leases expire, redelivery follows) — the
		// failure is loud here and safe in the database; no event is lost.
		r.log.Error("ack failed; rows will be redelivered", "err", err, "rows", len(seqs))
		return
	}
	r.Published.Add(int64(acked))
	if acked < len(seqs) {
		// Some leases moved to another relay mid-flight (slow publish or
		// crash window). Those rows were re-published by their new owner:
		// at-least-once, honestly accounted, never acked by the stale holder.
		r.Redeliveries.Add(int64(len(seqs) - acked))
		r.log.Warn("ack affected fewer rows than published; stale leases redelivered",
			"asked", len(seqs), "acked", acked)
	}
}

func (r *Relay) recordFailure(ctx context.Context, row postgres.RelayRow, cause error) {
	r.PublishFails.Add(1)
	exhausted, err := r.store.PublishFailed(ctx, r.cfg.ID, row.Seq, r.cfg.MaxRetries, cause.Error())
	if err != nil {
		r.log.Error("recording publish failure failed", "err", err, "seq", row.Seq)
		return
	}
	if exhausted {
		r.Exhausted.Add(1)
		r.log.Error("delivery exhausted; dead-letter filed", "seq", row.Seq,
			"workflow", row.WorkflowID, "step", row.StepType, "attempt", row.Attempt,
			"retries", r.cfg.MaxRetries, "last_err", cause)
		return
	}
	r.log.Warn("publish failed; row backed off for retry", "seq", row.Seq,
		"workflow", row.WorkflowID, "err", cause)
}

func seqsOf(rows []postgres.RelayRow) []int64 {
	seqs := make([]int64, len(rows))
	for i, row := range rows {
		seqs[i] = row.Seq
	}
	return seqs
}
