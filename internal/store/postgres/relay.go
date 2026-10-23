package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Lakhyajit-96/fathom/internal/id"
)

// Store half of the pgoutbox relay (SM §6, ADR-006/007, brief §7). Delivery
// discipline, stated honestly:
//
//   - claim is one statement: pick unpublished rows under FOR UPDATE SKIP
//     LOCKED and stamp a per-row claim lease (claimed_by/claimed_until, DB
//     clock) in the same UPDATE, then COMMIT. The publisher does its network
//     I/O with no transaction and no row lock held;
//   - at-least-once: a relay that crashes after claiming and before acking
//     redelivers the row once its lease expires — a duplicate publication is
//     the expected failure mode, and consumers dedupe by event_id (DATA §D);
//   - a stale relay cannot ack: AckPublished is guarded on claimed_by, so a
//     row whose lease expired and moved to another owner is never marked
//     published by the dead holder (its ack affects 0 rows);
//   - per-row policy is bounded: PublishFailed backs off (2s·2^n, cap 60s,
//     SM §8 family) and after maxRetries marks failed_at and files the
//     RETRY_EXHAUSTED dead-letter — the relay's own exhaustion, the one place
//     that class is produced (PHASE_5_SPEC_CHECKLIST §2.2).

// RelayRow is one claimed outbox row plus what the publisher needs.
type RelayRow struct {
	Seq         int64
	EventID     string
	WorkflowID  string
	AggregateID string // partition/event key (ADR-007)
	StepType    string
	Attempt     int
	Topic       string
	Payload     []byte
	RetryCount  int
}

// ClaimOutboxBatch atomically leases up to batchSize deliverable rows to
// relayID: never published, never failed, claim lease free or expired, and
// past any per-row backoff. Rows come back already leased — no second
// transaction touches them until ack or failure.
func (s *Store) ClaimOutboxBatch(ctx context.Context, relayID string, batchSize int, leaseTTL time.Duration) ([]RelayRow, error) {
	if relayID == "" {
		return nil, errors.New("store: relay claim requires a relay id")
	}
	if batchSize <= 0 {
		batchSize = 100
	}
	if leaseTTL <= 0 {
		leaseTTL = DefaultLeaseTTL
	}
	rows, err := s.pool.Query(ctx,
		`WITH pick AS (
		   SELECT seq
		     FROM outbox
		    WHERE published_at IS NULL AND failed_at IS NULL
		      AND (claimed_until IS NULL OR claimed_until <= now())
		      AND (next_retry_at IS NULL OR next_retry_at <= now())
		    ORDER BY seq
		    LIMIT $2
		    FOR UPDATE SKIP LOCKED
		 )
		 UPDATE outbox o
		    SET claimed_by = $1, claimed_until = now() + make_interval(secs => $3)
		   FROM pick p
		  WHERE o.seq = p.seq
		  RETURNING o.seq, o.event_id, o.workflow_id, o.aggregate_id, o.step_type, o.attempt,
		            o.topic, o.payload, o.retry_count`,
		relayID, batchSize, leaseTTL.Seconds())
	if err != nil {
		return nil, mapQueryErr(err, "claim outbox batch")
	}
	defer rows.Close()
	var out []RelayRow
	for rows.Next() {
		var r RelayRow
		if err := rows.Scan(&r.Seq, &r.EventID, &r.WorkflowID, &r.AggregateID,
			&r.StepType, &r.Attempt, &r.Topic, &r.Payload, &r.RetryCount); err != nil {
			return nil, mapQueryErr(err, "scan claimed outbox row")
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AckPublished marks seqs published by relayID and advances the relay's
// durable checkpoint (monotonic: GREATEST, so out-of-order batch acks never
// move the cursor backwards). Returns how many rows this relay still owned —
// fewer than asked means some leases expired mid-flight; those rows are
// somebody else's (or will be), and acking them would lie about delivery.
func (s *Store) AckPublished(ctx context.Context, relayID string, seqs []int64) (int, error) {
	if len(seqs) == 0 {
		return 0, nil
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, mapQueryErr(err, "begin ack")
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`UPDATE outbox SET published_at = now(), claimed_by = NULL, claimed_until = NULL, next_retry_at = NULL
		  WHERE seq = ANY($1) AND claimed_by = $2 AND published_at IS NULL
		  RETURNING seq`,
		seqs, relayID)
	if err != nil {
		return 0, mapQueryErr(err, "ack outbox rows")
	}
	var maxSeq int64
	var acked int
	for rows.Next() {
		var seq int64
		if err := rows.Scan(&seq); err != nil {
			return 0, mapQueryErr(err, "scan acked seq")
		}
		acked++
		if seq > maxSeq {
			maxSeq = seq
		}
	}
	if err := rows.Err(); err != nil {
		return 0, mapQueryErr(err, "iterate acked")
	}
	rows.Close()

	if maxSeq > 0 {
		if _, err := tx.Exec(ctx,
			`INSERT INTO relay_checkpoint (relay_name, last_seq, updated_at)
			 VALUES ($1, $2, now())
			 ON CONFLICT (relay_name) DO UPDATE
			    SET last_seq = GREATEST(relay_checkpoint.last_seq, EXCLUDED.last_seq),
			        updated_at = now()`,
			relayID, maxSeq); err != nil {
			return 0, mapQueryErr(err, "upsert checkpoint")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, mapQueryErr(err, "commit ack")
	}
	return acked, nil
}

// PublishFailed records one failed delivery attempt for a claimed row: backoff
// (2s·2^retry_count, cap 60s, DB clock) under maxRetries; at the budget the
// row is marked failed_at (excluded from claims) and a RETRY_EXHAUSTED
// dead-letter + audit are filed in the same transaction. Returns exhausted.
// A row this relay no longer owns (lease moved on) affects 0 rows: the honest
// answer is "not mine to mark", reported as exhausted=false, nil.
func (s *Store) PublishFailed(ctx context.Context, relayID string, seq int64, maxRetries int, detail string) (bool, error) {
	now := time.Now().UTC()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, mapQueryErr(err, "begin publish failure")
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var wfID, stepType string
	var attempt int
	var failedAt *time.Time
	err = tx.QueryRow(ctx,
		`UPDATE outbox
		    SET retry_count = retry_count + 1,
		        claimed_by = NULL,
		        claimed_until = NULL,
		        next_retry_at = CASE WHEN retry_count + 1 < $2
		            THEN now() + make_interval(secs => LEAST(60, 2 * power(2, retry_count)))
		            ELSE NULL END,
		        failed_at = CASE WHEN retry_count + 1 >= $2 THEN now() ELSE NULL END
		  WHERE seq = $1 AND claimed_by = $3 AND published_at IS NULL
		  RETURNING workflow_id, step_type, attempt, failed_at`,
		seq, maxRetries, relayID,
	).Scan(&wfID, &stepType, &attempt, &failedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // not ours any more — the new owner's problem to solve
	}
	if err != nil {
		return false, mapQueryErr(err, "record publish failure")
	}
	if failedAt == nil {
		if err := tx.Commit(ctx); err != nil {
			return false, mapQueryErr(err, "commit failure backoff")
		}
		return false, nil
	}

	dlID := id.New()
	if _, err := tx.Exec(ctx,
		`INSERT INTO dead_letter (id, workflow_id, step_type, attempt, class, reason_code, detail, created_at)
		 VALUES ($1,$2,$3,$4,'RETRY_EXHAUSTED','RELAY_DELIVERY_EXHAUSTED',$5::jsonb, now())`,
		dlID, wfID, stepType, attempt,
		jsonb(map[string]any{"outbox_seq": seq, "relay": relayID, "detail": detail,
			"dead_letter_id": dlID})); err != nil {
		return false, mapQueryErr(err, "insert exhausted dead letter")
	}
	if err := insertAudit(ctx, tx, wfID, auditKindDeadletter, nil, "",
		"DEADLETTER_INSERTED",
		map[string]any{"dead_letter_id": dlID, "class": "RETRY_EXHAUSTED", "step_type": stepType,
			"outbox_seq": seq, "relay": relayID}, "", now); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, mapQueryErr(err, "commit exhausted dead letter")
	}
	return true, nil
}

// GetRelayCheckpoint returns the durable cursor for a relay (0 before first
// ack) — used for lag metrics and resume assertions in tests.
func (s *Store) GetRelayCheckpoint(ctx context.Context, relayName string) (int64, error) {
	var seq int64
	err := s.pool.QueryRow(ctx,
		`SELECT last_seq FROM relay_checkpoint WHERE relay_name = $1`, relayName).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, mapQueryErr(err, "read relay checkpoint")
	}
	return seq, nil
}

// OutboxLag reports rows published beyond a relay's checkpoint — the true
// "how far behind is this relay" gauge (fathom_relay_lag), distinct from the
// global pending count: a healthy relay has lag 0 while a fresh one catches up.
func (s *Store) OutboxLag(ctx context.Context, relayName string) (int64, error) {
	var lag int64
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM outbox
		  WHERE seq > COALESCE((SELECT last_seq FROM relay_checkpoint WHERE relay_name = $1), 0)
		    AND published_at IS NULL AND failed_at IS NULL`,
		relayName).Scan(&lag)
	if err != nil {
		return 0, mapQueryErr(err, "relay lag")
	}
	return lag, nil
}
