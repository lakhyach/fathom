package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/lakhyach/fathom/internal/engine"
	"github.com/lakhyach/fathom/internal/id"
	"github.com/lakhyach/fathom/internal/tracing"
)

// Wire/event constants (DATA §E, ADR-010). The relay that moves these rows to
// Kafka is a later phase; this phase only guarantees they are written durably,
// atomically with the state change they describe.
const (
	eventTypeCommand = "fathom.command.issued.v1"
	topicCommands    = "fathom.commands.v1"
	commandSource    = "fathom.engine"
	specVersion      = "1.0"

	auditKindTransition = "TRANSITION"
	auditKindClassified = "EVENT_CLASSIFIED"
	auditKindDeadletter = "DEADLETTER"
	auditKindOperator   = "OPERATOR_ACTION"

	defaultIdempotencyTTL = 24 * time.Hour
)

// txMeta carries the identity of one durable write through the persist path:
// which audit kind the effects are recorded as, what caused them (event id for
// the causation chain), the trace context they belong to, and — for operator
// paths — the authenticated actor. Keeping it a struct (not positional args)
// exists so every effect of one transition shares one trace id and one
// causation link (REQ-OP-6, DATA §E) and nothing can half-wire an operator.
type txMeta struct {
	AuditKind  string // TRANSITION | EVENT_CLASSIFIED | OPERATOR_ACTION
	CauseEvent string // triggering event_id (causation_id of emitted commands)
	TraceID    string // 32-hex trace id; empty => a fresh one is minted per envelope
	Actor      string // operator key label; empty for non-operator writes
	ActorRole  string
	Reason     string // operator-supplied reason (>= 8 chars, validated upstream)
	// OperatorAction names the operator_action row to record alongside the
	// transition ("cancel", "retry-now", a W17 action); empty for machine- and
	// scheduler-driven writes, which have no privileged author to log.
	OperatorAction string
}

// terminalStateSQL is the belt-and-braces terminal wall reused in UPDATE
// predicates (SM §2 REQ-C-1): a rogue write cannot touch a terminal row even if
// the version check were bypassed.
const terminalStateSQL = `state NOT IN ('COMPLETED','FAILED','ABORTED')`

// CreateParams is one idempotent workflow-creation request (W1).
type CreateParams struct {
	IdempotencyKey string
	DefName        string
	DefVersion     int
	DefSnapshot    []byte // pinned JSON definition (JSONB)
	BusinessKey    string // one active workflow per target
	Input          []byte // workflow input (JSONB)
	Deadline       time.Time
	Steps          []engine.StepSpec
	IdempotencyTTL time.Duration // 0 => default
}

// CreateOutcome reports what a create call durably produced.
type CreateOutcome struct {
	Workflow engine.Workflow
	// Replayed is true when the same key + same fingerprint already produced
	// this workflow, so no second workflow was created (DATA §D).
	Replayed bool
	// ExistingID is set on replay (the first durable outcome's id).
	ExistingID string
}

// LoadWorkflow reads the durable snapshot the machine reasons over, steps in
// declaration (position) order. It returns NotFoundError for a genuinely absent
// row — never for a storage fault (DS-13).
func (s *Store) LoadWorkflow(ctx context.Context, wfID string) (engine.Workflow, error) {
	var wf engine.Workflow
	err := s.pool.QueryRow(ctx,
		`SELECT id, state, version FROM workflow WHERE id = $1`, wfID,
	).Scan(&wf.ID, &wf.State, &wf.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return wf, NotFoundError{WorkflowID: wfID}
	}
	if err != nil {
		return wf, mapQueryErr(err, "load workflow")
	}
	steps, err := s.loadSteps(ctx, wfID)
	if err != nil {
		return wf, err
	}
	wf.Steps = steps
	return wf, nil
}

func (s *Store) loadSteps(ctx context.Context, wfID string) ([]engine.Step, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT step_type, position, state, active_attempt, max_attempts, compensable
		   FROM step WHERE workflow_id = $1 ORDER BY position ASC`, wfID)
	if err != nil {
		return nil, mapQueryErr(err, "load steps")
	}
	defer rows.Close()
	var out []engine.Step
	for rows.Next() {
		var st engine.Step
		if err := rows.Scan(&st.Type, &st.Position, &st.State, &st.ActiveAttempt, &st.MaxAttempts, &st.Compensable); err != nil {
			return nil, mapQueryErr(err, "scan step")
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// loadSnapshotInTx loads the workflow + steps inside an open transaction,
// optionally taking the row lock (FOR UPDATE) so the version guard and the
// machine's classification see a stable, current snapshot (SM §2 guards run in
// one tx). forUpdate is mandatory for every mutation path.
func loadSnapshotInTx(ctx context.Context, tx pgx.Tx, wfID string, forUpdate bool) (engine.Workflow, error) {
	q := `SELECT id, state, version FROM workflow WHERE id = $1`
	if forUpdate {
		q += ` FOR UPDATE`
	}
	var wf engine.Workflow
	err := tx.QueryRow(ctx, q, wfID).Scan(&wf.ID, &wf.State, &wf.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return wf, NotFoundError{WorkflowID: wfID}
	}
	if err != nil {
		return wf, mapQueryErr(err, "load snapshot")
	}
	rows, err := tx.Query(ctx,
		`SELECT step_type, position, state, active_attempt, max_attempts, compensable
		   FROM step WHERE workflow_id = $1 ORDER BY position ASC`, wfID)
	if err != nil {
		return wf, mapQueryErr(err, "load steps in tx")
	}
	defer rows.Close()
	for rows.Next() {
		var st engine.Step
		if err := rows.Scan(&st.Type, &st.Position, &st.State, &st.ActiveAttempt, &st.MaxAttempts, &st.Compensable); err != nil {
			return wf, mapQueryErr(err, "scan step in tx")
		}
		wf.Steps = append(wf.Steps, st)
	}
	if err := rows.Err(); err != nil {
		return wf, mapQueryErr(err, "iterate steps")
	}
	return wf, nil
}

// CreateWorkflow realises W1 with durable idempotency, all in one transaction:
// idempotency reservation, workflow row (QUEUED, v1), step rows (PENDING), the
// creation audit and the first-step command intent in the outbox. On a repeat
// with a matching fingerprint it returns the first durable outcome without
// creating anything; a reused key with a different fingerprint is a typed
// conflict. A colliding active business key is a typed ActiveWorkflowError.
func (s *Store) CreateWorkflow(ctx context.Context, p CreateParams) (CreateOutcome, error) {
	hash, err := hashCreateRequest(createFingerprint{
		DefName:     p.DefName,
		DefVersion:  p.DefVersion,
		BusinessKey: p.BusinessKey,
		DefSnapshot: p.DefSnapshot,
		Input:       p.Input,
	})
	if err != nil {
		return CreateOutcome{}, err
	}
	ttl := p.IdempotencyTTL
	if ttl <= 0 {
		ttl = defaultIdempotencyTTL
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return CreateOutcome{}, fmt.Errorf("store: begin create: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Reserve the idempotency key. ON CONFLICT DO NOTHING lets exactly one
	//    concurrent writer own the create; the loser blocks on the row lock and
	//    then replays or conflicts against the committed outcome.
	tag, err := tx.Exec(ctx,
		`INSERT INTO api_idempotency (key, request_hash, expires_at)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (key) DO NOTHING`,
		p.IdempotencyKey, hash, time.Now().UTC().Add(ttl))
	if err != nil {
		return CreateOutcome{}, mapQueryErr(err, "reserve idempotency")
	}
	if tag.RowsAffected() == 0 {
		// Key already claimed: lock the row (waits for a concurrent creator to
		// resolve) and inspect the stored fingerprint.
		var stored []byte
		var existingID *string
		err := tx.QueryRow(ctx,
			`SELECT request_hash, workflow_id FROM api_idempotency WHERE key = $1 FOR UPDATE`,
			p.IdempotencyKey).Scan(&stored, &existingID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Concurrent creator rolled back; re-insert under us.
			if _, err := tx.Exec(ctx,
				`INSERT INTO api_idempotency (key, request_hash, expires_at) VALUES ($1, $2, $3)`,
				p.IdempotencyKey, hash, time.Now().UTC().Add(ttl)); err != nil {
				return CreateOutcome{}, mapQueryErr(err, "reserve idempotency retry")
			}
		} else if err != nil {
			return CreateOutcome{}, mapQueryErr(err, "read idempotency")
		} else {
			if !bytesEqual(stored, hash) {
				return CreateOutcome{}, IdempotencyConflictError{Key: p.IdempotencyKey}
			}
			if existingID == nil {
				return CreateOutcome{}, fmt.Errorf("store: idempotency %q committed without a workflow id", p.IdempotencyKey)
			}
			wf, err := s.loadInTx(ctx, tx, *existingID)
			if err != nil {
				return CreateOutcome{}, err
			}
			if err := tx.Commit(ctx); err != nil {
				return CreateOutcome{}, mapQueryErr(err, "commit replay")
			}
			return CreateOutcome{Workflow: wf, Replayed: true, ExistingID: *existingID}, nil
		}
	}

	// 2. Build the W1 snapshot with the pure machine, then persist it.
	newID := id.New()
	wf, effects := engine.Create(newID, p.Steps)
	wf.State = engine.StateQueued // machine invariant; explicit for the reader

	// The business-key guard is a UNIQUE violation, and a failed statement
	// ABORTS the transaction (25P02) — the conflicting-id lookup below would
	// otherwise die on the aborted block (an API integration test caught the
	// path never having been exercised at the store tier). A savepoint keeps
	// the one statement reversible inside the create transaction.
	if _, err := tx.Exec(ctx, `SAVEPOINT wf_insert`); err != nil {
		return CreateOutcome{}, mapQueryErr(err, "savepoint")
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO workflow (id, def_name, def_version, def_snapshot, state, version, business_key, input, deadline_at, created_at, updated_at)
		 VALUES ($1,$2,$3,$4::jsonb,'QUEUED',1,$5,$6::jsonb,$7, now(), now())`,
		newID, p.DefName, p.DefVersion, rawJSONText(p.DefSnapshot), p.BusinessKey, rawJSONText(p.Input), p.Deadline); err != nil {
		if isUniqueViolation(err, "workflow_active_business_key") {
			if _, rerr := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT wf_insert`); rerr != nil {
				return CreateOutcome{}, mapQueryErr(rerr, "rollback savepoint")
			}
			conflict, cerr := s.activeIDForBusinessKey(ctx, tx, p.BusinessKey)
			if cerr != nil {
				return CreateOutcome{}, cerr
			}
			return CreateOutcome{}, ActiveWorkflowError{BusinessKey: p.BusinessKey, ExistingID: conflict}
		}
		return CreateOutcome{}, mapQueryErr(err, "insert workflow")
	}

	for i, st := range wf.Steps {
		sp := p.Steps[i] // declaration-aligned definition data (timeouts, compensator task)
		var compTask *string
		if sp.CompensatorTask != "" {
			compTask = &sp.CompensatorTask
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO step (workflow_id, step_type, position, state, active_attempt, max_attempts, compensable,
			                  forward_timeout_secs, compensation_timeout_secs, compensator_task, version)
			 VALUES ($1,$2,$3,'PENDING',0,$4,$5,$6,$7,$8,1)`,
			newID, st.Type, st.Position, st.MaxAttempts, st.Compensable,
			int(sp.Timeout().Seconds()), int(engine.DefaultResponseTimeout.Seconds()), compTask); err != nil {
			return CreateOutcome{}, mapQueryErr(err, "insert step")
		}
	}

	created := time.Now().UTC()
	createMeta := txMeta{AuditKind: auditKindTransition, TraceID: tracing.TraceID(tracing.NewTraceparent())}
	if err := writeEffects(ctx, tx, newID, engine.Result{Workflow: wf}, effects, createMeta, nil, string(engine.StateQueued), created); err != nil {
		return CreateOutcome{}, err
	}

	// 3. Bind the durable outcome to the key for future replays.
	if _, err := tx.Exec(ctx,
		`UPDATE api_idempotency SET workflow_id = $2 WHERE key = $1`,
		p.IdempotencyKey, newID); err != nil {
		return CreateOutcome{}, mapQueryErr(err, "record idempotency outcome")
	}

	if err := tx.Commit(ctx); err != nil {
		return CreateOutcome{}, mapQueryErr(err, "commit create")
	}
	return CreateOutcome{Workflow: wf}, nil
}

// ApplyResult is the engine ingress for one inbound participant result (SM §5).
// It stores the raw envelope before classifying, runs the pure machine under the
// row lock, and — only for an APPLIED verdict — persists state, version bump,
// step rows, the dedup ledger, audit and outbox atomically. Every non-APPLIED
// verdict records the inbound row + one audit and changes no state.
//
// This is the unleased Phase-4 path: callers that drive execution through
// worker leases must use SubmitResult, which additionally enforces the lease
// gate (an expired/transferred lease downgrades an otherwise-APPLIED result to
// STALE without touching state — SM §4.3 fencing at the store boundary).
func (s *Store) ApplyResult(ctx context.Context, ev engine.ResultEvent, raw []byte) (engine.Classification, error) {
	return s.applyResult(ctx, ev, raw, nil)
}

// SubmitResult applies a result submitted by the named worker, gated on it
// still holding a LIVE lease on the step (database clock). A displaced or
// expired holder gets ClassStale and a RESULT_STALE_LEASE audit — the late
// word of a dead worker can never rewrite live state, and the rejection is
// recorded, not dropped (SM §5: ignored != invisible).
func (s *Store) SubmitResult(ctx context.Context, ev engine.ResultEvent, raw []byte, workerID string) (engine.Classification, error) {
	return s.applyResult(ctx, ev, raw, &workerID)
}

func (s *Store) applyResult(ctx context.Context, ev engine.ResultEvent, raw []byte, leaseWorker *string) (engine.Classification, error) {
	now := time.Now().UTC()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", fmt.Errorf("store: begin apply: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Dedup ledger is the source of truth for DUPLICATE (event_id already applied).
	var known bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM processed_events WHERE event_id = $1)`, ev.EventID).Scan(&known); err != nil {
		return "", mapQueryErr(err, "check dedup")
	}

	// Store the raw envelope BEFORE classification (SM §5: ignored != invisible).
	// Skip when the exact event_id is already recorded (byte-identical redelivery).
	if !known {
		if _, err := tx.Exec(ctx,
			`INSERT INTO inbound_event (event_id, workflow_id, step_type, attempt, raw, received_at)
			 VALUES ($1,$2,$3,$4,$5::jsonb, now())
			 ON CONFLICT (event_id) DO NOTHING`,
			ev.EventID, ev.WorkflowID, ev.StepType, ev.Attempt, rawJSONText(raw)); err != nil {
			return "", mapQueryErr(err, "insert inbound_event")
		}
	}

	loaded, err := loadSnapshotInTx(ctx, tx, ev.WorkflowID, true)
	if err != nil {
		return "", err
	}

	res, err := engine.ApplyResult(loaded, ev, known, now)
	if err != nil {
		// Machine-level rejections become typed store errors, never silent.
		var sv engine.StaleVersionError
		if errors.As(err, &sv) {
			return "", ConflictError{WorkflowID: ev.WorkflowID, Expected: sv.Expected, Actual: sv.Actual}
		}
		return "", err
	}

	class := res.Classification
	// Lease gate (SubmitResult only): the machine would APPLY this result, but
	// its submitting worker no longer provably holds the step's lease. Discard
	// the transition's effects entirely and record a STALE verdict instead; no
	// dedup entry, so the authoritative result for the live attempt still
	// applies normally when it arrives.
	staleLease := false
	if class == engine.ClassApplied && leaseWorker != nil {
		held, err := stepLeaseHeld(ctx, tx, ev.WorkflowID, ev.StepType, *leaseWorker)
		if err != nil {
			return "", err
		}
		if !held {
			class = engine.ClassStale
			staleLease = true
		}
	}
	// Record the classification on the (fresh) inbound row.
	if !known {
		if _, err := tx.Exec(ctx,
			`UPDATE inbound_event SET classification = $2 WHERE event_id = $1`,
			ev.EventID, string(class)); err != nil {
			return "", mapQueryErr(err, "classify inbound")
		}
	}

	if class != engine.ClassApplied {
		// DUPLICATE / TERMINAL_IGNORED / UNSOLICITED / STALE: exactly one audit,
		// zero state change (SM §3.7/3.8/3.9). Machine returns the unchanged
		// snapshot plus one classification audit effect. A stale-lease rejection
		// replaces the would-be transition's effects with its own audit.
		m := txMeta{AuditKind: auditKindClassified, CauseEvent: ev.EventID, TraceID: ev.TraceID}
		effs := res.Effects
		if staleLease {
			effs = []engine.Effect{{Kind: engine.EffectAudit, ReasonCode: "RESULT_STALE_LEASE", StepType: ev.StepType, Attempt: ev.Attempt}}
		}
		if err := writeEffects(ctx, tx, ev.WorkflowID, res, effs, m, strOrNull(loaded.State), string(loaded.State), now); err != nil {
			return "", err
		}
		if err := tx.Commit(ctx); err != nil {
			return "", mapQueryErr(err, "commit classify")
		}
		return class, nil
	}

	// APPLIED: settle the resolved attempt (forward results only), then persist
	// the transition. A compensator result reuses the forward attempt number and
	// the attempt CHECK has no COMPENSATED state, so it is recorded via the step
	// state + audit instead of mutating the settled forward attempt row.
	if loaded.State != engine.StateCompensating {
		if err := settleAttempt(ctx, tx, ev.WorkflowID, ev.StepType, ev.Attempt, ev.Outcome, ev.ErrorClass, now); err != nil {
			return "", err
		}
	}
	// Record the event in the dedup ledger inside this same transaction, so a
	// redelivery is classified DUPLICATE and produces zero state effect (DATA §D).
	// The FK to inbound_event holds because the raw envelope was just stored.
	if _, err := tx.Exec(ctx,
		`INSERT INTO processed_events (event_id, workflow_id, applied_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (event_id) DO NOTHING`, ev.EventID, ev.WorkflowID); err != nil {
		return "", mapQueryErr(err, "record dedup")
	}
	if err := s.commitTransition(ctx, tx, loaded, res, txMeta{
		AuditKind: auditKindTransition, CauseEvent: ev.EventID, TraceID: ev.TraceID,
	}, now); err != nil {
		return "", err
	}
	return class, nil
}

// Start drives W2 (QUEUED -> RUNNING) when the engine issues the first command.
func (s *Store) Start(ctx context.Context, wfID string, expectedVersion int64) (engine.Workflow, error) {
	return s.runTransition(ctx, wfID, txMeta{AuditKind: auditKindTransition}, func(loaded engine.Workflow, now time.Time) (engine.Result, error) {
		return engine.Start(loaded, expectedVersion, now)
	})
}

// Retry drives W6 (RETRY_WAITING -> RUNNING) when the durable due-time is
// reached; the scheduler loop that decides to call it lives in internal/scheduler.
func (s *Store) Retry(ctx context.Context, wfID string, expectedVersion int64) (engine.Workflow, error) {
	return s.runTransition(ctx, wfID, txMeta{AuditKind: auditKindTransition}, func(loaded engine.Workflow, now time.Time) (engine.Result, error) {
		return engine.Retry(loaded, expectedVersion, now)
	})
}

// Cancel applies W14/W14b. Terminal and COMPENSATING targets are refused with
// the machine's typed error, surfaced unchanged. When issued by an
// authenticated operator the action is recorded (actor/reason) in the same
// transaction; reason is empty only for internal callers.
func (s *Store) Cancel(ctx context.Context, wfID string, expectedVersion int64, op Operator) (engine.Workflow, error) {
	m := txMeta{AuditKind: auditKindTransition, Actor: op.Actor, ActorRole: op.Role, Reason: op.Reason}
	if op.Actor != "" {
		m.AuditKind = auditKindOperator
		m.OperatorAction = ActionCancel
	}
	return s.runTransition(ctx, wfID, m, func(loaded engine.Workflow, _ time.Time) (engine.Result, error) {
		return engine.Cancel(loaded, expectedVersion)
	})
}

// TimeoutStep applies the forward response-deadline outcome (SM §8) for a step.
func (s *Store) TimeoutStep(ctx context.Context, wfID, stepType string, expectedVersion int64) (engine.Workflow, error) {
	return s.runTransition(ctx, wfID, txMeta{AuditKind: auditKindTransition}, func(loaded engine.Workflow, now time.Time) (engine.Result, error) {
		return engine.TimeoutStep(loaded, stepType, expectedVersion, now)
	})
}

// EscalateDeadline applies W13 for a workflow whose durable deadline has
// passed; like every runTransition body it re-evaluates under the row lock, so
// a workflow that completed between the scheduler scan and this write simply
// hits the machine's terminal/version guards and changes nothing.
func (s *Store) EscalateDeadline(ctx context.Context, wfID string, expectedVersion int64) (engine.Workflow, error) {
	return s.runTransition(ctx, wfID, txMeta{AuditKind: auditKindTransition}, func(loaded engine.Workflow, _ time.Time) (engine.Result, error) {
		return engine.EscalateDeadline(loaded, expectedVersion)
	})
}

// RetryNow applies W18 on behalf of an authenticated operator: immediate
// re-issue of a RETRY_WAITING workflow, bypassing backoff but not the guards.
func (s *Store) RetryNow(ctx context.Context, wfID string, expectedVersion int64, op Operator) (engine.Workflow, error) {
	m := txMeta{AuditKind: auditKindOperator, OperatorAction: ActionRetryNow, Actor: op.Actor, ActorRole: op.Role, Reason: op.Reason}
	return s.runTransition(ctx, wfID, m, func(loaded engine.Workflow, _ time.Time) (engine.Result, error) {
		return engine.RetryNow(loaded, expectedVersion)
	})
}

// runTransition wraps the shared load-guard-persist body for the machine
// entry points that take only an expected version.
func (s *Store) runTransition(ctx context.Context, wfID string, m txMeta, fn func(engine.Workflow, time.Time) (engine.Result, error)) (engine.Workflow, error) {
	return s.runTransitionPost(ctx, wfID, m, fn, nil)
}

// runTransitionPost is runTransition with an in-transaction hook run after the
// machine verdict but before commit — the lease-reclaim path uses it to settle
// the lost attempt row in the same atomic unit.
func (s *Store) runTransitionPost(ctx context.Context, wfID string, m txMeta, fn func(engine.Workflow, time.Time) (engine.Result, error), post func(pctx context.Context, tx pgx.Tx, loaded, out engine.Workflow) error) (engine.Workflow, error) {
	now := time.Now().UTC()
	if m.TraceID == "" {
		m.TraceID = tracing.TraceID(tracing.NewTraceparent())
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return engine.Workflow{}, fmt.Errorf("store: begin transition: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	loaded, err := loadSnapshotInTx(ctx, tx, wfID, true)
	if err != nil {
		return engine.Workflow{}, err
	}
	res, err := fn(loaded, now)
	if err != nil {
		var sv engine.StaleVersionError
		if errors.As(err, &sv) {
			return engine.Workflow{}, ConflictError{WorkflowID: wfID, Expected: sv.Expected, Actual: sv.Actual}
		}
		return engine.Workflow{}, err
	}
	if post != nil {
		if err := post(ctx, tx, loaded, res.Workflow); err != nil {
			return engine.Workflow{}, err
		}
	}
	if err := s.commitTransition(ctx, tx, loaded, res, m, now); err != nil {
		return engine.Workflow{}, err
	}
	return res.Workflow, nil
}

// commitTransition persists an APPLIED machine result (applyTransition) and
// commits — the two-step body every transition entry point shares.
func (s *Store) commitTransition(ctx context.Context, tx pgx.Tx, loaded engine.Workflow, res engine.Result, m txMeta, now time.Time) error {
	if err := applyTransition(ctx, tx, loaded, res, m, now); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return mapQueryErr(err, "commit transition")
	}
	return nil
}

// applyTransition writes the guarded workflow UPDATE, the changed step rows,
// every effect (audit, outbox command, dead-letter) and — for operator paths —
// the operator_action record, all in the caller's transaction but WITHOUT
// committing: ResolveDeadLetter adds its DLQ resolution write between apply
// and commit. A 0-row guard becomes a typed ConflictError — never a silent
// overwrite (DS-4).
func applyTransition(ctx context.Context, tx pgx.Tx, loaded engine.Workflow, res engine.Result, m txMeta, now time.Time) error {
	fromState := loaded.State
	newState := res.Workflow.State

	var next *time.Time
	if !res.NextAttemptAt.IsZero() {
		t := res.NextAttemptAt.UTC()
		next = &t
	} else if loaded.State == engine.StateRetryWaiting && newState != engine.StateRetryWaiting {
		// Leaving RETRY_WAITING clears the durable schedule (NULL, not stale).
		next = nil
	}

	tag, err := tx.Exec(ctx,
		`UPDATE workflow
		    SET state = $2,
		        version = version + 1,
		        next_attempt_at = $3::timestamptz,
		        started_at = COALESCE(started_at, CASE WHEN $2 = 'RUNNING' THEN $4::timestamptz ELSE NULL END),
		        finished_at = CASE WHEN $2 IN ('COMPLETED','FAILED','ABORTED') THEN $4::timestamptz ELSE NULL END,
		        updated_at = $4::timestamptz
		  WHERE id = $1 AND version = $5 AND `+terminalStateSQL,
		loaded.ID, string(newState), next, now, loaded.Version)
	if err != nil {
		return mapQueryErr(err, "guarded update workflow")
	}
	if tag.RowsAffected() != 1 {
		// Someone else advanced the row (or it went terminal) since we read the
		// snapshot under lock — impossible under FOR UPDATE, kept as the second
		// wall. Resolve the current version to report an accurate conflict.
		var cur int64
		var curState engine.WorkflowState
		_ = tx.QueryRow(ctx, `SELECT version, state FROM workflow WHERE id = $1`, loaded.ID).Scan(&cur, &curState)
		return ConflictError{WorkflowID: loaded.ID, Expected: loaded.Version, Actual: cur, terminalNow: curState.IsTerminal()}
	}

	if err := syncSteps(ctx, tx, loaded.ID, loaded.Steps, res.Workflow.Steps); err != nil {
		return err
	}
	if err := writeEffects(ctx, tx, loaded.ID, res, res.Effects, m, strOrNull(fromState), string(newState), now); err != nil {
		return err
	}
	return insertOperatorAction(ctx, tx, loaded.ID, loaded, res.Workflow, m, false)
}

// syncSteps writes back only the steps whose state or active attempt changed,
// and it is the single place the durable timing columns are maintained:
// issuing a forward step stamps response_deadline_at from the step's declared
// forward timeout (SM §8; DATABASE clock, so replicas agree), entering
// compensation stamps compensation_deadline_at, and every write-back releases
// any lease — a settled or re-issued step has no live claimant (a fresh claim
// re-acquires one; §4.3 fencing then makes the displaced worker's late result
// STALE).
func syncSteps(ctx context.Context, tx pgx.Tx, wfID string, old, neu []engine.Step) error {
	oldByType := make(map[string]engine.Step, len(old))
	for _, st := range old {
		oldByType[st.Type] = st
	}
	for _, st := range neu {
		prev, ok := oldByType[st.Type]
		if ok && prev.State == st.State && prev.ActiveAttempt == st.ActiveAttempt {
			continue
		}
		if _, err := tx.Exec(ctx,
			`UPDATE step SET state = $3, active_attempt = $4, version = version + 1,
			            lease_holder = NULL, lease_expires_at = NULL,
			            response_deadline_at = CASE WHEN $3 = 'ISSUED'
			                THEN now() + make_interval(secs => forward_timeout_secs) ELSE NULL END,
			            compensation_deadline_at = CASE WHEN $3 = 'COMPENSATING'
			                THEN now() + make_interval(secs => compensation_timeout_secs) ELSE NULL END
			  WHERE workflow_id = $1 AND step_type = $2`,
			wfID, st.Type, string(st.State), st.ActiveAttempt); err != nil {
			return mapQueryErr(err, "sync step")
		}
	}
	return nil
}

// writeEffects persists the durable side effects a transition carries, all in
// the caller's transaction. Effects are data produced by the pure machine; this
// is the only place they touch the database.
func writeEffects(ctx context.Context, tx pgx.Tx, wfID string, res engine.Result, effects []engine.Effect, m txMeta, fromState *string, toState string, now time.Time) error {
	for _, eff := range effects {
		switch eff.Kind {
		case engine.EffectAudit:
			detail := map[string]any{"reason_code": eff.ReasonCode}
			if eff.StepType != "" {
				detail["step_type"] = eff.StepType
			}
			if eff.Attempt >= 0 {
				detail["attempt"] = eff.Attempt
			}
			if m.CauseEvent != "" {
				detail["event_id"] = m.CauseEvent
			}
			if m.Actor != "" {
				// T-04: destructive/privileged decisions carry the authenticated
				// actor and the operator reason in the audit detail.
				detail["actor"] = m.Actor
				detail["role"] = m.ActorRole
				detail["reason"] = m.Reason
			}
			if err := insertAudit(ctx, tx, wfID, m.AuditKind, fromState, toState, eff.ReasonCode, detail, m.TraceID, now); err != nil {
				return err
			}
		case engine.EffectOutbox:
			if err := writeOutbox(ctx, tx, wfID, eff, res, m, now); err != nil {
				return err
			}
		case engine.EffectDeadLetter:
			class := "COMPENSATION"
			switch eff.ReasonCode {
			case "RETRY_EXHAUSTED", "DEADLINE", "LEASE_LOST", "UNPARSEABLE_EVENT", "COMPENSATION":
				class = eff.ReasonCode
			}
			dlID := id.New()
			if _, err := tx.Exec(ctx,
				`INSERT INTO dead_letter (id, workflow_id, step_type, attempt, class, reason_code, detail, created_at)
				 VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, now())`,
				dlID, wfID, eff.StepType, nullInt(eff.Attempt), class, eff.ReasonCode,
				jsonb(map[string]any{"dead_letter_id": dlID, "step_type": eff.StepType, "attempt": eff.Attempt})); err != nil {
				return mapQueryErr(err, "insert dead_letter")
			}
			if err := insertAudit(ctx, tx, wfID, auditKindDeadletter, fromState, toState, "DEADLETTER_INSERTED",
				map[string]any{"dead_letter_id": dlID, "class": class, "step_type": eff.StepType}, m.TraceID, now); err != nil {
				return err
			}
		}
	}
	return nil
}

// writeOutbox emits a command-issuance intent and (idempotently) opens the
// matching attempt row, both in-transaction. The envelope carries the full
// DATA §E identity block; traceparent continues the transition's trace (or a
// fresh one when nothing propagated), and causation_id names the inbound
// event that caused this command when there was one.
func writeOutbox(ctx context.Context, tx pgx.Tx, wfID string, eff engine.Effect, res engine.Result, m txMeta, now time.Time) error {
	eventID := id.New()
	causation := m.CauseEvent
	if causation == "" {
		causation = res.Workflow.ID // scheduler/creation-driven commands are caused by the workflow itself
	}
	envelope := map[string]any{
		"specversion":     specVersion,
		"id":              eventID,
		"source":          commandSource,
		"type":            eventTypeCommand,
		"time":            now.UTC().Format(time.RFC3339Nano),
		"subject":         wfID,
		"workflow_id":     wfID,
		"step_type":       eff.StepType,
		"attempt":         eff.Attempt,
		"causation_id":    causation,
		"traceparent":     tracing.FromTraceID(m.TraceID),
		"datacontenttype": "application/json",
		"data": map[string]any{
			"intent":       eff.ReasonCode,
			"compensation": eff.IsCompensation,
		},
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO outbox (event_id, workflow_id, aggregate_id, step_type, attempt, event_type, topic, payload, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, now())`,
		eventID, wfID, wfID, eff.StepType, eff.Attempt, eventTypeCommand, topicCommands, jsonb(envelope)); err != nil {
		return mapQueryErr(err, "insert outbox")
	}
	if eff.Attempt >= 1 {
		// Open the attempt ledger row the result will later settle. Idempotent:
		// a re-issued command for an existing attempt must not collide (DS-7).
		if _, err := tx.Exec(ctx,
			`INSERT INTO attempt (workflow_id, step_type, number, state, started_at)
			 VALUES ($1,$2,$3,'ISSUED', now())
			 ON CONFLICT (workflow_id, step_type, number) DO NOTHING`,
			wfID, eff.StepType, eff.Attempt); err != nil {
			return mapQueryErr(err, "insert attempt")
		}
	}
	return nil
}

// settleAttempt records the terminal outcome of the attempt a result answers.
func settleAttempt(ctx context.Context, tx pgx.Tx, wfID, stepType string, attempt int, outcome engine.Outcome, class engine.ErrorClass, now time.Time) error {
	state := "SUCCEEDED"
	if outcome == engine.OutcomeFailed {
		state = "FAILED"
	}
	var ec *string
	if state == "FAILED" && class != "" {
		s := string(class)
		ec = &s
	}
	_, err := tx.Exec(ctx,
		`UPDATE attempt
		    SET state = $4, error_class = $5, finished_at = now()
		  WHERE workflow_id = $1 AND step_type = $2 AND number = $3`,
		wfID, stepType, attempt, state, ec)
	if err != nil {
		return mapQueryErr(err, "settle attempt")
	}
	return nil
}

func insertAudit(ctx context.Context, tx pgx.Tx, wfID, kind string, fromState *string, toState, reasonCode string, detail map[string]any, traceID string, now time.Time) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO audit_event (workflow_id, kind, from_state, to_state, reason_code, detail, trace_id, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7, now())`,
		wfID, kind, fromState, nullStr(toState), reasonCode, jsonb(detail), nullStr(traceID))
	if err != nil {
		return mapQueryErr(err, "insert audit_event")
	}
	return nil
}

// loadInTx loads a snapshot via the store pool inside tx (used for replay).
func (s *Store) loadInTx(ctx context.Context, tx pgx.Tx, wfID string) (engine.Workflow, error) {
	return loadSnapshotInTx(ctx, tx, wfID, false)
}

func (s *Store) activeIDForBusinessKey(ctx context.Context, tx pgx.Tx, businessKey string) (string, error) {
	var existingID string
	err := tx.QueryRow(ctx,
		`SELECT id FROM workflow
		 WHERE business_key = $1 AND `+terminalStateSQL+`
		 ORDER BY created_at DESC LIMIT 1`, businessKey).Scan(&existingID)
	if err != nil {
		return "", mapQueryErr(err, "lookup active business key")
	}
	return existingID, nil
}

// ---- encoding helpers ------------------------------------------------------

// jsonb marshals v to canonical JSON text for a `$n::jsonb` parameter. Passing
// text with an explicit cast keeps pgx from choosing a bytea codec for a []byte.
func jsonb(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		// A marshal failure is a programming bug (unsupported type), and no
		// column may legitimately hold it; surfacing the panic at the boundary
		// is honest rather than silently writing "null".
		panic("store: marshal jsonb: " + err.Error())
	}
	return string(b)
}

// rawJSONText passes already-encoded JSON through untouched. jsonb() must
// NEVER receive a []byte: json.Marshal turns byte slices into base64
// strings, and the column would then hold a JSON string of base64 instead
// of the document (an API-tier integration test caught the wire effect).
// Callers guarantee the bytes are valid JSON — they arrive parsed or
// canonicalised, and the ::jsonb cast is the second wall.
func rawJSONText(b []byte) string {
	if len(b) == 0 {
		return "null"
	}
	return string(b)
}

func strOrNull(s engine.WorkflowState) *string {
	v := string(s)
	return &v
}

func nullInt(i int) *int {
	if i < 0 {
		return nil
	}
	return &i
}

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
