package postgres

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lakhyach/fathom/internal/engine"
)

// Reaper/scheduler scans (SM §8, ADR-012: deadlines are data). These are the
// only queries the recovery loop needs, and they deliberately take NO locks:
// a scan is a candidate list, not a reservation. Every follow-up write goes
// through the version-guarded transition path, so any number of replicas can
// scan the same rows and exactly one still wins — the losers get a typed
// ConflictError and simply re-evaluate on the next tick. Clock comparisons
// use the database's now() so all replicas agree on what "due" means.

// OverdueKind names what a scan found expired; the reaper dispatches on it.
type OverdueKind string

const (
	// OverdueLease: a held lease past its expiry — the worker died mid-step;
	// handled by engine.ReclaimLease (fencing token rises).
	OverdueLease OverdueKind = "LEASE_EXPIRED"
	// OverdueTimeout: the forward response deadline passed — handled by
	// engine.TimeoutStep whether or not a lease is live (a late answer to a
	// timed-out attempt is classified, not applied as forward work).
	OverdueTimeout OverdueKind = "RESPONSE_TIMEOUT"
)

// OverdueStep is one reclaim/timeout candidate. Version is the workflow
// version observed at scan time; it is the caller's optimistic handle —
// stale by write time is fine, the guard refuses the double transition.
type OverdueStep struct {
	WorkflowID string
	StepType   string
	Version    int64
	Kind       OverdueKind
}

// WorkflowCandidate is a workflow-level scan hit (queue start, deadline).
type WorkflowCandidate struct {
	ID      string
	Version int64
}

// RetryCandidate is a due RETRY_WAITING row: DueAt is the durable schedule
// (database clock) and Attempt the step's current active attempt — what the
// reaper needs to compute its jitter window (SM §8: full jitter is a reaper
// concern at W6, not machine data).
type RetryCandidate struct {
	ID      string
	Version int64
	DueAt   time.Time
	Attempt int
}

// ScanDueRetries lists RETRY_WAITING workflows whose durable next_attempt_at
// has arrived (W6 candidates). Order is due-time first so a small batch limit
// cannot starve long-waiting work. The attempt comes from the step awaiting
// retry (FAILED/TIMED_OUT — exactly one while RETRY_WAITING holds).
func (s *Store) ScanDueRetries(ctx context.Context, limit int) ([]RetryCandidate, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT w.id, w.version, w.next_attempt_at, COALESCE(MAX(s.active_attempt), 1)
		   FROM workflow w
		   LEFT JOIN step s ON s.workflow_id = w.id AND s.state IN ('FAILED','TIMED_OUT')
		  WHERE w.state = 'RETRY_WAITING' AND w.next_attempt_at IS NOT NULL AND w.next_attempt_at <= now()
		  GROUP BY w.id, w.version, w.next_attempt_at
		  ORDER BY w.next_attempt_at
		  LIMIT $1`, limit)
	if err != nil {
		return nil, mapQueryErr(err, "scan due retries")
	}
	defer rows.Close()
	var out []RetryCandidate
	for rows.Next() {
		var c RetryCandidate
		if err := rows.Scan(&c.ID, &c.Version, &c.DueAt, &c.Attempt); err != nil {
			return nil, mapQueryErr(err, "scan retry row")
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ScanQueued lists QUEUED workflows awaiting their first command (W2
// candidates), oldest first.
func (s *Store) ScanQueued(ctx context.Context, limit int) ([]WorkflowCandidate, error) {
	return s.scanWorkflows(ctx, limit,
		`SELECT id, version FROM workflow WHERE state = 'QUEUED' ORDER BY created_at`)
}

// ScanExpiredDeadlines lists live workflows past their durable deadline_at
// (W13 candidates). FAILED_MANUAL is excluded because it is inert (§2 †):
// reaping it again would fight the operator contract, and its DLQ item
// already exists by construction.
func (s *Store) ScanExpiredDeadlines(ctx context.Context, limit int) ([]WorkflowCandidate, error) {
	return s.scanWorkflows(ctx, limit,
		`SELECT id, version FROM workflow
		  WHERE state IN ('QUEUED','RUNNING','RETRY_WAITING','COMPENSATING','CANCELLING')
		    AND deadline_at <= now()
		  ORDER BY deadline_at`)
}

func (s *Store) scanWorkflows(ctx context.Context, limit int, q string) ([]WorkflowCandidate, error) {
	// The suffix is a constant with a placeholder — limit rides as a parameter,
	// never concatenated.
	rows, err := s.pool.Query(ctx, q+" LIMIT $1", limit)
	if err != nil {
		return nil, mapQueryErr(err, "scan workflows")
	}
	defer rows.Close()
	var out []WorkflowCandidate
	for rows.Next() {
		var c WorkflowCandidate
		if err := rows.Scan(&c.ID, &c.Version); err != nil {
			return nil, mapQueryErr(err, "scan workflow row")
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ScanOverdueSteps lists steps whose worker lease expired (reclaim) or whose
// forward response deadline passed (timeout), lease losses first: a dead
// worker blocks the step's own timeout path until reclaimed, so prioritising
// it keeps recovery moving under a small batch limit.
func (s *Store) ScanOverdueSteps(ctx context.Context, limit int) ([]OverdueStep, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT workflow_id, step_type, version, kind FROM (
		   SELECT s.workflow_id, s.step_type, w.version, $2::text AS kind, 0 AS prio
		     FROM step s JOIN workflow w ON w.id = s.workflow_id
		    WHERE s.lease_expires_at IS NOT NULL AND s.lease_expires_at <= now()
		      AND ((w.state = 'RUNNING' AND s.state IN ('ISSUED','IN_PROGRESS'))
		        OR (w.state = 'COMPENSATING' AND s.state = 'COMPENSATING'))
		   UNION ALL
		   SELECT s.workflow_id, s.step_type, w.version, $3::text, 1
		     FROM step s JOIN workflow w ON w.id = s.workflow_id
		    WHERE w.state = 'RUNNING' AND s.state IN ('ISSUED','IN_PROGRESS')
		      AND s.response_deadline_at <= now()
		 ) t
		 ORDER BY prio, workflow_id
		 LIMIT $1`,
		limit, string(OverdueLease), string(OverdueTimeout))
	if err != nil {
		return nil, mapQueryErr(err, "scan overdue steps")
	}
	defer rows.Close()
	var out []OverdueStep
	for rows.Next() {
		var o OverdueStep
		var kind string
		if err := rows.Scan(&o.WorkflowID, &o.StepType, &o.Version, &kind); err != nil {
			return nil, mapQueryErr(err, "scan overdue row")
		}
		o.Kind = OverdueKind(kind)
		out = append(out, o)
	}
	return out, rows.Err()
}

// ReclaimLease is the store half of §4.3: it runs engine.ReclaimLease under
// the workflow lock and, in the same transaction, settles the dead holder's
// forward attempt LOST in the ledger before the re-issued command opens the
// next attempt row. Compensation reclaims settle no attempt row: the attempt
// ledger tracks the forward execution only (the compensation write-back
// records its own audit), so bumping there would destroy forward history.
//
// Expected version is whatever the scan saw; a workflow that moved on (the
// worker actually finished, or the step timed out first) fails the guard and
// changes nothing — which is the correct outcome, not an error to fight.
func (s *Store) ReclaimLease(ctx context.Context, wfID, stepType string, expectedVersion int64) (engine.Workflow, error) {
	return s.runTransitionPost(ctx, wfID, txMeta{AuditKind: auditKindTransition},
		func(loaded engine.Workflow, _ time.Time) (engine.Result, error) {
			return engine.ReclaimLease(loaded, stepType, expectedVersion)
		},
		func(ctx context.Context, tx pgx.Tx, loaded, out engine.Workflow) error {
			if loaded.State != engine.StateRunning {
				return nil // compensation arm: no forward attempt to settle
			}
			var lost int
			for _, st := range loaded.Steps {
				if st.Type == stepType {
					lost = st.ActiveAttempt
				}
			}
			if lost < 1 {
				return nil
			}
			_, err := tx.Exec(ctx,
				`UPDATE attempt SET state = 'LOST', finished_at = now()
				  WHERE workflow_id = $1 AND step_type = $2 AND number = $3
				    AND state IN ('ISSUED','IN_PROGRESS')`,
				wfID, stepType, lost)
			if err != nil {
				return mapQueryErr(err, "settle lost attempt")
			}
			return nil
		})
}
