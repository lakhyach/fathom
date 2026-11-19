package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/lakhyach/fathom/internal/engine"
	"github.com/lakhyach/fathom/internal/id"
	"github.com/lakhyach/fathom/internal/tracing"
)

// Operator is the authenticated identity behind a privileged call (ADR-013,
// THREAT T-04). It is produced only by the API layer from a verified bearer
// key — the store never invents one. Reason is operator-supplied and
// mandatory for recorded actions (the operator_action CHECK enforces >= 8
// characters; that floor is validated upstream so errors surface as 4xx, not
// as raw DB constraint failures).
type Operator struct {
	Actor  string // bearer-key label; never a fabricated identity
	Role   string // reader | operator | admin
	Reason string
}

// Operator action names recorded in operator_action.action (DATA §A.4). They
// mirror the API verbs exactly so an audit read needs no translation table.
const (
	ActionCancel               = "cancel"
	ActionRetryNow             = "retry-now"
	ActionForceTerminate       = "force-terminate"
	ActionCompleteCompensation = "complete-compensation"
)

// DeadLetterNotFoundError reports a DLQ item id that does not exist (the API
// renders 404). Distinct from DeadLetterResolvedError (409): resolution is a
// durable one-shot, and "already done" must not masquerade as "absent" (DS-13).
type DeadLetterNotFoundError struct{ ID string }

func (e DeadLetterNotFoundError) Error() string {
	return fmt.Sprintf("store: dead letter %s not found", e.ID)
}

// DeadLetterResolvedError reports the DLQ item was already resolved (or was
// claimed for resolution concurrently); no state changes.
type DeadLetterResolvedError struct{ ID string }

func (e DeadLetterResolvedError) Error() string {
	return fmt.Sprintf("store: dead letter %s is already resolved", e.ID)
}

// ResolveDeadLetter drives W17 for one dead-letter item: an operator chooses
// force-terminate (-> FAILED) or complete-compensation (-> ABORTED) for a
// FAILED_MANUAL workflow, and the item is closed in the same transaction that
// moves the workflow (SM §7: resolution is durable operator work, not a
// best-effort second write).
//
// dryRun computes the machine outcome under the row locks and records the
// operator_action with dry_run = TRUE, but writes no state — the preview an
// operator asks for before committing to a destructive decision (REQ-OP-5).
// The engine call re-evaluates the full guard set under FOR UPDATE, so a
// workflow that left FAILED_MANUAL between listing and resolving is refused
// by the machine, not by a stale check-then-act.
func (s *Store) ResolveDeadLetter(ctx context.Context, dlID string, action engine.ManualAction, op Operator, dryRun bool) (engine.Workflow, error) {
	if op.Actor == "" {
		return engine.Workflow{}, fmt.Errorf("store: dead-letter resolution requires an authenticated operator")
	}
	now := time.Now().UTC()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return engine.Workflow{}, fmt.Errorf("store: begin resolve: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var wfID string
	var resolvedAt *time.Time
	err = tx.QueryRow(ctx,
		`SELECT workflow_id, resolved_at FROM dead_letter WHERE id = $1 FOR UPDATE`, dlID,
	).Scan(&wfID, &resolvedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return engine.Workflow{}, DeadLetterNotFoundError{ID: dlID}
	}
	if err != nil {
		return engine.Workflow{}, mapQueryErr(err, "lock dead letter")
	}
	if resolvedAt != nil {
		return engine.Workflow{}, DeadLetterResolvedError{ID: dlID}
	}

	loaded, err := loadSnapshotInTx(ctx, tx, wfID, true)
	if err != nil {
		return engine.Workflow{}, err
	}
	res, err := engine.ResolveManual(loaded, loaded.Version, action)
	if err != nil {
		var sv engine.StaleVersionError
		if errors.As(err, &sv) {
			return engine.Workflow{}, ConflictError{WorkflowID: wfID, Expected: sv.Expected, Actual: sv.Actual}
		}
		return engine.Workflow{}, err
	}

	m := txMeta{
		AuditKind: auditKindOperator, OperatorAction: string(action),
		Actor: op.Actor, ActorRole: op.Role, Reason: op.Reason,
		TraceID: tracing.TraceID(tracing.NewTraceparent()),
	}

	if dryRun {
		// Record the preview only. The workflow/step rows are untouched — the
		// FOR UPDATE locks we hold make the preview exact as of commit time.
		if err := insertOperatorAction(ctx, tx, wfID, loaded, res.Workflow, m, true); err != nil {
			return engine.Workflow{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return engine.Workflow{}, mapQueryErr(err, "commit dry run")
		}
		return res.Workflow, nil
	}

	if err := applyTransition(ctx, tx, loaded, res, m, now); err != nil {
		return engine.Workflow{}, err
	}
	tag, err := tx.Exec(ctx,
		`UPDATE dead_letter SET resolved_at = now(), resolved_by = $2, resolution = $3
		  WHERE id = $1 AND resolved_at IS NULL`,
		dlID, op.Actor, string(action))
	if err != nil {
		return engine.Workflow{}, mapQueryErr(err, "resolve dead letter")
	}
	if tag.RowsAffected() != 1 {
		// Unreachable while we hold the row lock — kept as the honest wall.
		return engine.Workflow{}, DeadLetterResolvedError{ID: dlID}
	}
	if err := tx.Commit(ctx); err != nil {
		return engine.Workflow{}, mapQueryErr(err, "commit resolve")
	}
	return res.Workflow, nil
}

// insertOperatorAction writes the DATA §A.4 authorization record for one
// privileged action: who (actor/role), why (reason), what it looked like
// before (pre_snapshot), and what it produced (result; a preview when
// dry_run). Called from applyTransition for wired operator paths and directly
// for the dry-run. Silently skips non-operator writes (no actor/action).
func insertOperatorAction(ctx context.Context, tx pgx.Tx, wfID string, pre, out engine.Workflow, m txMeta, dryRun bool) error {
	if m.OperatorAction == "" || m.Actor == "" {
		return nil
	}
	result := map[string]any{"state": string(out.State), "version": out.Version}
	if dryRun {
		result["dry_run_preview"] = true
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO operator_action (id, workflow_id, actor, role, action, reason, dry_run, pre_snapshot, result, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb, now())`,
		id.New(), wfID, m.Actor, m.ActorRole, m.OperatorAction, m.Reason, dryRun,
		jsonb(map[string]any{"state": string(pre.State), "version": pre.Version}),
		jsonb(result))
	if err != nil {
		return mapQueryErr(err, "insert operator_action")
	}
	return nil
}
