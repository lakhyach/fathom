package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Worker claiming with leases (SM §4, brief §2). The rules this file enforces:
//
//   - a claim is ONE statement: pick a free step under FOR UPDATE SKIP LOCKED
//     and stamp the lease in the same UPDATE, so two workers can never both
//     believe they hold a step;
//   - an expired lease is NOT claimable here. Expired leases belong to the
//     reaper: it reclaims via engine.ReclaimLease, which settles the lost
//     attempt and raises the fencing token (attempt) before the step becomes
//     claimable again (ADR-009). Claiming around that path would let a worker
//     execute at a stale fencing token;
//   - no transaction is open while a participant executes: the claim commits
//     immediately; results arrive through SubmitResult, a separate transaction
//     whose lease gate refuses displaced workers (RESULT_STALE_LEASE);
//   - lease arithmetic uses DATABASE time everywhere (now()), so replicas with
//     skewed clocks cannot disagree about who holds a step (SM §4.1).

// DefaultLeaseTTL is the SM §8 lease TTL (90s). Callers pass their config
// value; this is the shared fallback so store and worker agree by default.
const DefaultLeaseTTL = 90 * time.Second

// Claim is one leased unit of participant work. Attempt is the fencing token
// the worker must carry in its result envelope; Task is the participant task
// to execute — the compensator's task for compensation claims (SM §1
// compensator{task}, falling back to the step's own task when undeclared).
type Claim struct {
	WorkflowID   string
	StepType     string
	Task         string
	Attempt      int
	Compensation bool
}

// ClaimStep atomically takes the oldest unleased step the engine considers
// executable, or returns ok=false when there is nothing to claim. "Unleased"
// means lease_expires_at IS NULL — fresh issued work (syncSteps clears leases
// on write-back) or a lease a worker explicitly released. Expired leases are
// deliberately NOT claimable here: they belong to the reaper's reclaim path
// (see header), which raises the fencing token before the step re-appears.
//
// CANCELLING workflows are not claimable: W14b only waits for an already
// in-flight result or lets the timeout path wind down, so handing out NEW work
// mid-cancel would fight that contract. Compensation claims are matched by
// step state COMPENSATING under a COMPENSATING workflow.
func (s *Store) ClaimStep(ctx context.Context, workerID string, leaseTTL time.Duration) (Claim, bool, error) {
	if workerID == "" {
		return Claim{}, false, fmt.Errorf("store: claim requires a worker id")
	}
	if leaseTTL <= 0 {
		leaseTTL = DefaultLeaseTTL
	}
	var c Claim
	var state string
	var compTask *string
	err := s.pool.QueryRow(ctx,
		`WITH pick AS (
		   SELECT s.workflow_id, s.step_type
		     FROM step s
		     JOIN workflow w ON w.id = s.workflow_id
		    WHERE ((w.state = 'RUNNING' AND s.state IN ('ISSUED','IN_PROGRESS'))
		        OR (w.state = 'COMPENSATING' AND s.state = 'COMPENSATING'))
		      AND s.lease_expires_at IS NULL
		    ORDER BY s.workflow_id
		    LIMIT 1
		    FOR UPDATE OF s SKIP LOCKED
		 )
		 UPDATE step s
		    SET lease_holder = $1,
		        lease_expires_at = now() + make_interval(secs => $2),
		        state = CASE WHEN s.state = 'ISSUED' THEN 'IN_PROGRESS' ELSE s.state END,
		        version = version + 1
		   FROM pick p
		  WHERE s.workflow_id = p.workflow_id AND s.step_type = p.step_type
		  RETURNING s.workflow_id, s.step_type, s.state, s.active_attempt, s.compensator_task`,
		workerID, leaseTTL.Seconds(),
	).Scan(&c.WorkflowID, &c.StepType, &state, &c.Attempt, &compTask)
	if errors.Is(err, pgx.ErrNoRows) {
		return Claim{}, false, nil // nothing claimable right now
	}
	if err != nil {
		return Claim{}, false, mapQueryErr(err, "claim step")
	}
	c.Compensation = state == string(engineStepCompensating)
	c.Task = c.StepType
	if c.Compensation && compTask != nil {
		c.Task = *compTask
	}
	return c, true, nil
}

// engineStepCompensating is the step-state literal a compensation claim
// carries after the claim UPDATE (kept as a constant so the SQL and Go
// branches name the same value).
const engineStepCompensating = "COMPENSATING"

// RenewLease extends workerID's lease on a step, returning false (no error)
// when the worker no longer provably holds a live lease — the heartbeat's
// "you were displaced, stop" signal. It bumps no state and no fencing token;
// only the reaper's reclaim path raises versions (the step's row version
// increments here as pure write accounting).
func (s *Store) RenewLease(ctx context.Context, wfID, stepType, workerID string, leaseTTL time.Duration) (bool, error) {
	if leaseTTL <= 0 {
		leaseTTL = DefaultLeaseTTL
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE step SET lease_expires_at = now() + make_interval(secs => $4), version = version + 1
		  WHERE workflow_id = $1 AND step_type = $2 AND lease_holder = $3 AND lease_expires_at > now()`,
		wfID, stepType, workerID, leaseTTL.Seconds())
	if err != nil {
		return false, mapQueryErr(err, "renew lease")
	}
	return tag.RowsAffected() == 1, nil
}

// ReleaseLease voluntarily gives back a live lease (worker shutdown, or it
// decided not to execute). Guarded on holder + liveness so a displaced worker
// can never release a lease that already moved on. The step stays
// ISSUED/IN_PROGRESS with a NULL lease, immediately claimable again.
func (s *Store) ReleaseLease(ctx context.Context, wfID, stepType, workerID string) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE step SET lease_holder = NULL, lease_expires_at = NULL, version = version + 1
		  WHERE workflow_id = $1 AND step_type = $2 AND lease_holder = $3`,
		wfID, stepType, workerID)
	if err != nil {
		return false, mapQueryErr(err, "release lease")
	}
	return tag.RowsAffected() == 1, nil
}

// CommandTraceparent returns the traceparent of the latest command envelope
// issued for (workflow, step, attempt) —"" when no row carries one. A worker
// answering that command continues this trace into its result (REQ-OP-6), so
// one workflow run stays one trace across the durable boundary.
func (s *Store) CommandTraceparent(ctx context.Context, wfID, stepType string, attempt int) (string, error) {
	var tp *string
	err := s.pool.QueryRow(ctx,
		`SELECT payload->>'traceparent' FROM outbox
		  WHERE workflow_id = $1 AND step_type = $2 AND attempt = $3
		  ORDER BY seq DESC LIMIT 1`,
		wfID, stepType, attempt).Scan(&tp)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", mapQueryErr(err, "read command traceparent")
	}
	if tp == nil {
		return "", nil
	}
	return *tp, nil
}

// stepLeaseHeld reports, under the step's row lock, whether workerID provably
// holds a LIVE lease right now (database clock). It is the SubmitResult gate:
// the workflow row is already locked by the enclosing transaction before this
// runs, so the lock order workflow->step stays consistent with every other
// write path (claim takes the step lock only and never writes workflow).
func stepLeaseHeld(ctx context.Context, tx pgx.Tx, wfID, stepType, workerID string) (bool, error) {
	var held bool
	err := tx.QueryRow(ctx,
		`SELECT COALESCE(lease_holder = $3, FALSE) AND COALESCE(lease_expires_at > now(), FALSE)
		   FROM step WHERE workflow_id = $1 AND step_type = $2 FOR UPDATE`,
		wfID, stepType, workerID).Scan(&held)
	if err != nil {
		return false, mapQueryErr(err, "check step lease")
	}
	return held, nil
}
