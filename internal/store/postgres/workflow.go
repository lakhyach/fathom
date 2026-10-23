package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Lakhyajit-96/fathom/internal/engine"
	"github.com/Lakhyajit-96/fathom/internal/id"
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

	defaultIdempotencyTTL = 24 * time.Hour
)

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

	if _, err := tx.Exec(ctx,
		`INSERT INTO workflow (id, def_name, def_version, def_snapshot, state, version, business_key, input, deadline_at, created_at, updated_at)
		 VALUES ($1,$2,$3,$4::jsonb,'QUEUED',1,$5,$6::jsonb,$7, now(), now())`,
		newID, p.DefName, p.DefVersion, jsonb(p.DefSnapshot), p.BusinessKey, jsonb(p.Input), p.Deadline); err != nil {
		if isUniqueViolation(err, "workflow_active_business_key") {
			conflict, cerr := s.activeIDForBusinessKey(ctx, tx, p.BusinessKey)
			if cerr != nil {
				return CreateOutcome{}, cerr
			}
			return CreateOutcome{}, ActiveWorkflowError{BusinessKey: p.BusinessKey, ExistingID: conflict}
		}
		return CreateOutcome{}, mapQueryErr(err, "insert workflow")
	}

	for _, st := range wf.Steps {
		if _, err := tx.Exec(ctx,
			`INSERT INTO step (workflow_id, step_type, position, state, active_attempt, max_attempts, compensable, version)
			 VALUES ($1,$2,$3,'PENDING',0,$4,$5,1)`,
			newID, st.Type, st.Position, st.MaxAttempts, st.Compensable); err != nil {
			return CreateOutcome{}, mapQueryErr(err, "insert step")
		}
	}

	if err := writeEffects(ctx, tx, newID, engine.Result{Workflow: wf}, effects, auditKindTransition, "", nil, string(engine.StateQueued), time.Now().UTC()); err != nil {
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
func (s *Store) ApplyResult(ctx context.Context, ev engine.ResultEvent, raw []byte) (engine.Classification, error) {
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
			ev.EventID, ev.WorkflowID, ev.StepType, ev.Attempt, jsonb(raw)); err != nil {
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
		// snapshot plus one classification audit effect.
		if err := writeEffects(ctx, tx, ev.WorkflowID, res, res.Effects, auditKindClassified, ev.EventID, strOrNull(loaded.State), string(loaded.State), now); err != nil {
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
	if err := s.commitTransition(ctx, tx, loaded, res, auditKindTransition, ev.EventID, now); err != nil {
		return "", err
	}
	return class, nil
}

// Start drives W2 (QUEUED -> RUNNING) when the engine issues the first command.
func (s *Store) Start(ctx context.Context, wfID string, expectedVersion int64) (engine.Workflow, error) {
	return s.runTransition(ctx, wfID, func(loaded engine.Workflow, now time.Time) (engine.Result, error) {
		return engine.Start(loaded, expectedVersion, now)
	})
}

// Retry drives W6 (RETRY_WAITING -> RUNNING) when the durable due-time is
// reached; the reaper that decides to call it is a later phase.
func (s *Store) Retry(ctx context.Context, wfID string, expectedVersion int64) (engine.Workflow, error) {
	return s.runTransition(ctx, wfID, func(loaded engine.Workflow, now time.Time) (engine.Result, error) {
		return engine.Retry(loaded, expectedVersion, now)
	})
}

// Cancel applies W14/W14b. Terminal and COMPENSATING targets are refused with
// the machine's typed error, surfaced unchanged.
func (s *Store) Cancel(ctx context.Context, wfID string, expectedVersion int64) (engine.Workflow, error) {
	return s.runTransition(ctx, wfID, func(loaded engine.Workflow, _ time.Time) (engine.Result, error) {
		return engine.Cancel(loaded, expectedVersion)
	})
}

// TimeoutStep applies the forward response-deadline outcome (SM §8) for a step.
func (s *Store) TimeoutStep(ctx context.Context, wfID, stepType string, expectedVersion int64) (engine.Workflow, error) {
	return s.runTransition(ctx, wfID, func(loaded engine.Workflow, now time.Time) (engine.Result, error) {
		return engine.TimeoutStep(loaded, stepType, expectedVersion, now)
	})
}

// runTransition wraps the shared load-guard-persist body for the machine
// entry points that take only an expected version (Start/Retry/Cancel/Timeout).
func (s *Store) runTransition(ctx context.Context, wfID string, fn func(engine.Workflow, time.Time) (engine.Result, error)) (engine.Workflow, error) {
	now := time.Now().UTC()
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
	if err := s.commitTransition(ctx, tx, loaded, res, auditKindTransition, "", now); err != nil {
		return engine.Workflow{}, err
	}
	return res.Workflow, nil
}

// commitTransition persists an APPLIED machine result under the version guard:
// the guarded workflow UPDATE, the changed step rows, and every effect (audit,
// outbox command, dead-letter) in the same transaction. A 0-row guard becomes a
// typed ConflictError — never a silent overwrite (DS-4).
func (s *Store) commitTransition(ctx context.Context, tx pgx.Tx, loaded engine.Workflow, res engine.Result, auditKind string, causeEventID string, now time.Time) error {
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
	if err := writeEffects(ctx, tx, loaded.ID, res, res.Effects, auditKind, causeEventID, strOrNull(fromState), string(newState), now); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return mapQueryErr(err, "commit transition")
	}
	return nil
}

// syncSteps writes back only the steps whose state or active attempt changed.
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
			`UPDATE step SET state = $3, active_attempt = $4, version = version + 1
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
func writeEffects(ctx context.Context, tx pgx.Tx, wfID string, res engine.Result, effects []engine.Effect, auditKind string, causeEventID string, fromState *string, toState string, now time.Time) error {
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
			if causeEventID != "" {
				detail["event_id"] = causeEventID
			}
			if err := insertAudit(ctx, tx, wfID, auditKind, fromState, toState, eff.ReasonCode, detail, now); err != nil {
				return err
			}
		case engine.EffectOutbox:
			if err := writeOutbox(ctx, tx, wfID, eff, res, now); err != nil {
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
				map[string]any{"dead_letter_id": dlID, "class": class, "step_type": eff.StepType}, now); err != nil {
				return err
			}
		}
	}
	return nil
}

// writeOutbox emits a command-issuance intent and (idempotently) opens the
// matching attempt row, both in-transaction.
func writeOutbox(ctx context.Context, tx pgx.Tx, wfID string, eff engine.Effect, res engine.Result, now time.Time) error {
	eventID := id.New()
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
		"causation_id":    res.Workflow.ID,
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

func insertAudit(ctx context.Context, tx pgx.Tx, wfID, kind string, fromState *string, toState, reasonCode string, detail map[string]any, now time.Time) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO audit_event (workflow_id, kind, from_state, to_state, reason_code, detail, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6::jsonb, now())`,
		wfID, kind, fromState, toState, reasonCode, jsonb(detail))
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
