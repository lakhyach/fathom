package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Read models for the API (DATA §B) and gauges for metrics (OBS §2). These
// queries never lock and never write; timestamps marshal as RFC3339 via the
// API layer's JSON encoder, and every list is keyset-paged (DATA §B: cursors
// are (sort-column, id) pairs, opaque to clients, stable under concurrent
// inserts). UUID ordering works because ids are uuidv7 (time-sortable).

// StepView is one step row in full detail: machine state plus the Phase-5
// operational columns (lease, durable deadlines, compensator task).
type StepView struct {
	StepType               string     `json:"step_type"`
	Position               int        `json:"position"`
	State                  string     `json:"state"`
	ActiveAttempt          int        `json:"active_attempt"`
	MaxAttempts            int        `json:"max_attempts"`
	Compensable            bool       `json:"compensable"`
	LeaseHolder            *string    `json:"lease_holder"`
	LeaseExpiresAt         *time.Time `json:"lease_expires_at"`
	ResponseDeadlineAt     *time.Time `json:"response_deadline_at"`
	CompensationDeadlineAt *time.Time `json:"compensation_deadline_at"`
	CompensatorTask        *string    `json:"compensator_task"`
}

// WorkflowView is the full workflow detail: instance columns + its steps in
// declaration order. Input/def snapshot ride as raw JSON.
type WorkflowView struct {
	ID            string     `json:"id"`
	DefName       string     `json:"def_name"`
	DefVersion    int        `json:"def_version"`
	DefSnapshot   []byte     `json:"def_snapshot"`
	State         string     `json:"state"`
	Version       int64      `json:"version"`
	BusinessKey   string     `json:"business_key"`
	Input         []byte     `json:"input"`
	DeadlineAt    time.Time  `json:"deadline_at"`
	NextAttemptAt *time.Time `json:"next_attempt_at"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	StartedAt     *time.Time `json:"started_at"`
	FinishedAt    *time.Time `json:"finished_at"`
	Steps         []StepView `json:"steps"`
}

// GetWorkflowDetail loads one workflow with its steps (API GET /workflows/{id}).
func (s *Store) GetWorkflowDetail(ctx context.Context, wfID string) (WorkflowView, error) {
	var v WorkflowView
	err := s.pool.QueryRow(ctx,
		`SELECT id, def_name, def_version, def_snapshot, state, version, business_key, input,
		        deadline_at, next_attempt_at, created_at, updated_at, started_at, finished_at
		   FROM workflow WHERE id = $1`, wfID,
	).Scan(&v.ID, &v.DefName, &v.DefVersion, &v.DefSnapshot, &v.State, &v.Version,
		&v.BusinessKey, &v.Input, &v.DeadlineAt, &v.NextAttemptAt,
		&v.CreatedAt, &v.UpdatedAt, &v.StartedAt, &v.FinishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkflowView{}, NotFoundError{WorkflowID: wfID}
	}
	if err != nil {
		return WorkflowView{}, mapQueryErr(err, "load workflow detail")
	}
	rows, err := s.pool.Query(ctx,
		`SELECT step_type, position, state, active_attempt, max_attempts, compensable,
		        lease_holder, lease_expires_at, response_deadline_at, compensation_deadline_at, compensator_task
		   FROM step WHERE workflow_id = $1 ORDER BY position`, wfID)
	if err != nil {
		return WorkflowView{}, mapQueryErr(err, "load step views")
	}
	defer rows.Close()
	for rows.Next() {
		var st StepView
		if err := rows.Scan(&st.StepType, &st.Position, &st.State, &st.ActiveAttempt,
			&st.MaxAttempts, &st.Compensable, &st.LeaseHolder, &st.LeaseExpiresAt,
			&st.ResponseDeadlineAt, &st.CompensationDeadlineAt, &st.CompensatorTask); err != nil {
			return WorkflowView{}, mapQueryErr(err, "scan step view")
		}
		v.Steps = append(v.Steps, st)
	}
	return v, rows.Err()
}

// WorkflowSummary is one row of GET /workflows (list page).
type WorkflowSummary struct {
	ID          string     `json:"id"`
	DefName     string     `json:"def_name"`
	DefVersion  int        `json:"def_version"`
	State       string     `json:"state"`
	Version     int64      `json:"version"`
	BusinessKey string     `json:"business_key"`
	DeadlineAt  time.Time  `json:"deadline_at"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	FinishedAt  *time.Time `json:"finished_at"`
}

// ListWorkflows pages workflows newest-first (uuidv7 descends with age);
// state and business_key are optional exact-match filters; afterID is the
// keyset cursor from the previous page ("" = first page). The API derives the
// next cursor from the last returned id.
func (s *Store) ListWorkflows(ctx context.Context, state, businessKey, afterID string, limit int) ([]WorkflowSummary, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, def_name, def_version, state, version, business_key, deadline_at, created_at, updated_at, finished_at
		   FROM workflow
		  WHERE ($1::text IS NULL OR state = $1)
		    AND ($2::text IS NULL OR business_key = $2)
		    AND ($3::uuid IS NULL OR id < $3)
		  ORDER BY id DESC
		  LIMIT $4`,
		nullStr(state), nullStr(businessKey), nullStr(afterID), limit)
	if err != nil {
		return nil, mapQueryErr(err, "list workflows")
	}
	defer rows.Close()
	var out []WorkflowSummary
	for rows.Next() {
		var w WorkflowSummary
		if err := rows.Scan(&w.ID, &w.DefName, &w.DefVersion, &w.State, &w.Version,
			&w.BusinessKey, &w.DeadlineAt, &w.CreatedAt, &w.UpdatedAt, &w.FinishedAt); err != nil {
			return nil, mapQueryErr(err, "scan workflow summary")
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// AuditRow is one append-only audit entry; Seq is the global SSE-resumable id.
type AuditRow struct {
	Seq        int64     `json:"seq"`
	Kind       string    `json:"kind"`
	FromState  *string   `json:"from_state"`
	ToState    string    `json:"to_state"`
	ReasonCode string    `json:"reason_code"`
	Detail     []byte    `json:"detail"`
	TraceID    *string   `json:"trace_id"`
	CreatedAt  time.Time `json:"created_at"`
}

// ListAudit pages a workflow's audit trail by ascending seq (afterSeq = -1
// for the full history; the SSE cursor uses the same order).
func (s *Store) ListAudit(ctx context.Context, wfID string, afterSeq int64, limit int) ([]AuditRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT seq, kind, from_state, to_state, reason_code, detail, trace_id, created_at
		   FROM audit_event WHERE workflow_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
		wfID, afterSeq, limit)
	if err != nil {
		return nil, mapQueryErr(err, "list audit")
	}
	defer rows.Close()
	var out []AuditRow
	for rows.Next() {
		var a AuditRow
		if err := rows.Scan(&a.Seq, &a.Kind, &a.FromState, &a.ToState, &a.ReasonCode,
			&a.Detail, &a.TraceID, &a.CreatedAt); err != nil {
			return nil, mapQueryErr(err, "scan audit row")
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// InboundRow is one stored envelope with its classification (API "events"
// ingress view: ignored != invisible).
type InboundRow struct {
	EventID        string    `json:"event_id"`
	StepType       *string   `json:"step_type"`
	Attempt        *int      `json:"attempt"`
	ReceivedAt     time.Time `json:"received_at"`
	Classification *string   `json:"classification"`
	Raw            []byte    `json:"raw"`
}

// ListInbound pages a workflow's inbound envelopes, oldest first, keyset on
// (received_at, event_id). Zero afterTime = first page.
func (s *Store) ListInbound(ctx context.Context, wfID string, afterTime time.Time, afterID string, limit int) ([]InboundRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT event_id, step_type, attempt, received_at, classification, raw
		   FROM inbound_event
		  WHERE workflow_id = $1
		    AND ($2::timestamptz IS NULL OR (received_at, event_id) > ($2, $3::uuid))
		  ORDER BY received_at, event_id
		  LIMIT $4`,
		wfID, optionalTime(afterTime), nullStr(afterID), limit)
	if err != nil {
		return nil, mapQueryErr(err, "list inbound")
	}
	defer rows.Close()
	var out []InboundRow
	for rows.Next() {
		var r InboundRow
		if err := rows.Scan(&r.EventID, &r.StepType, &r.Attempt, &r.ReceivedAt, &r.Classification, &r.Raw); err != nil {
			return nil, mapQueryErr(err, "scan inbound row")
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AttemptRow is one attempt-ledger entry (API per-step attempt history).
type AttemptRow struct {
	StepType    string     `json:"step_type"`
	Number      int        `json:"number"`
	State       string     `json:"state"`
	ErrorClass  *string    `json:"error_class"`
	ErrorDetail []byte     `json:"error_detail"`
	StartedAt   time.Time  `json:"started_at"`
	FinishedAt  *time.Time `json:"finished_at"`
}

func (s *Store) ListAttempts(ctx context.Context, wfID string) ([]AttemptRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT a.step_type, a.number, a.state, a.error_class, a.error_detail, a.started_at, a.finished_at
		   FROM attempt a
		   JOIN step s ON s.workflow_id = a.workflow_id AND s.step_type = a.step_type
		  WHERE a.workflow_id = $1
		  ORDER BY s.position, a.number`,
		wfID)
	if err != nil {
		return nil, mapQueryErr(err, "list attempts")
	}
	defer rows.Close()
	var out []AttemptRow
	for rows.Next() {
		var r AttemptRow
		if err := rows.Scan(&r.StepType, &r.Number, &r.State, &r.ErrorClass,
			&r.ErrorDetail, &r.StartedAt, &r.FinishedAt); err != nil {
			return nil, mapQueryErr(err, "scan attempt row")
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeadLetterRow is one DLQ item (SM §7 / API /dead-letters).
type DeadLetterRow struct {
	ID         string     `json:"id"`
	WorkflowID string     `json:"workflow_id"`
	StepType   *string    `json:"step_type"`
	Attempt    *int       `json:"attempt"`
	Class      string     `json:"class"`
	ReasonCode string     `json:"reason_code"`
	Detail     []byte     `json:"detail"`
	CreatedAt  time.Time  `json:"created_at"`
	ResolvedAt *time.Time `json:"resolved_at"`
	ResolvedBy *string    `json:"resolved_by"`
	Resolution *string    `json:"resolution"`
}

// ListDeadLetters pages DLQ items (open-only for the operator queue), keyset
// on (created_at, id), oldest first — operator work is FIFO by arrival.
// class and workflowID are optional exact-match filters (DATA §B GET /v1/dlq).
func (s *Store) ListDeadLetters(ctx context.Context, openOnly bool, class, workflowID string, afterTime time.Time, afterID string, limit int) ([]DeadLetterRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, workflow_id, step_type, attempt, class, reason_code, detail, created_at,
		        resolved_at, resolved_by, resolution
		   FROM dead_letter
		  WHERE ($1::bool IS FALSE OR resolved_at IS NULL)
		    AND ($2::text IS NULL OR class = $2)
		    AND ($3::uuid IS NULL OR workflow_id = $3)
		    AND ($4::timestamptz IS NULL OR (created_at, id) > ($4, $5::uuid))
		  ORDER BY created_at, id
		  LIMIT $6`,
		openOnly, nullStr(class), nullStr(workflowID), optionalTime(afterTime), nullStr(afterID), limit)
	if err != nil {
		return nil, mapQueryErr(err, "list dead letters")
	}
	defer rows.Close()
	var out []DeadLetterRow
	for rows.Next() {
		var r DeadLetterRow
		if err := rows.Scan(&r.ID, &r.WorkflowID, &r.StepType, &r.Attempt, &r.Class,
			&r.ReasonCode, &r.Detail, &r.CreatedAt, &r.ResolvedAt, &r.ResolvedBy, &r.Resolution); err != nil {
			return nil, mapQueryErr(err, "scan dead letter")
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ---- metric gauges (OBS §2; each reads the real operation it names) --------

// OutboxPending reports unpublished, un-failed rows and the age in seconds of
// the oldest — the relay-lag pair (fathom_outbox_pending, fathom_outbox_oldest_age).
func (s *Store) OutboxPending(ctx context.Context) (count int64, oldestAge float64, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT count(*), COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::double precision
		   FROM outbox WHERE published_at IS NULL AND failed_at IS NULL`,
	).Scan(&count, &oldestAge)
	if err != nil {
		return 0, 0, mapQueryErr(err, "outbox pending")
	}
	return count, oldestAge, nil
}

// DeadLettersOpen counts unresolved DLQ items (fathom_deadletters_open).
func (s *Store) DeadLettersOpen(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM dead_letter WHERE resolved_at IS NULL`).Scan(&n)
	if err != nil {
		return 0, mapQueryErr(err, "open dead letters")
	}
	return n, nil
}

// WorkflowsByState returns live+terminal workflow counts per state
// (fathom_workflows{state=...}); empty map when the table is empty.
func (s *Store) WorkflowsByState(ctx context.Context) (map[string]int64, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT state, count(*) FROM workflow GROUP BY state`)
	if err != nil {
		return nil, mapQueryErr(err, "workflows by state")
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var st string
		var n int64
		if err := rows.Scan(&st, &n); err != nil {
			return nil, mapQueryErr(err, "scan state count")
		}
		out[st] = n
	}
	return out, rows.Err()
}

// LeasesHeld counts live worker leases (fathom_leases_held) — the worker
// liveness gauge the dashboard reads to see claimed-but-unfinished work.
func (s *Store) LeasesHeld(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM step WHERE lease_expires_at IS NOT NULL AND lease_expires_at > now()`).Scan(&n)
	if err != nil {
		return 0, mapQueryErr(err, "leases held")
	}
	return n, nil
}

// ---- small encoding helpers -------------------------------------------------

// optionalTime maps the zero time (first page) to a NULL parameter.
func optionalTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}
