package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Lakhyajit-96/fathom/internal/engine"
	postgres "github.com/Lakhyajit-96/fathom/internal/store/postgres"
)

// listStates mirrors the CHECK on workflow.state in migration 0001. The
// duplication is deliberate: a typo'd list filter must be a loud 422 at the
// edge, not a silent empty page (DS-13's honesty principle applied to reads).
var listStates = map[string]bool{
	"QUEUED": true, "RUNNING": true, "RETRY_WAITING": true,
	"COMPENSATING": true, "CANCELLING": true, "FAILED_MANUAL": true,
	"COMPLETED": true, "FAILED": true, "ABORTED": true,
}

// operator builds the audit actor from the authenticated credential — the
// key LABEL, never an invented identity (brief §6).
func operatorFrom(r *http.Request) postgres.Operator {
	cred, _ := credFrom(r.Context())
	return postgres.Operator{Actor: cred.Label, Role: cred.Role.String()}
}

// failInternal is the single funnel for faults that are the server's, not
// the client's: the real error goes to the log (with the trace id), the
// client gets the stable INTERNAL problem — never SQL text, never a 404
// disguise (DS-13).
func (s *Server) failInternal(w http.ResponseWriter, r *http.Request, err error, msg string) {
	s.log.Error("api: "+msg, "err", err, "path", r.URL.Path, "request_id", requestID(r.Context()))
	writeProblem(w, r, s.log, problemInternal())
}

// ---- POST /v1/workflows -----------------------------------------------------

type createRequest struct {
	DefName     string          `json:"def_name"`
	BusinessKey string          `json:"business_key"`
	Input       json.RawMessage `json:"input"`
	Deadline    *time.Time      `json:"deadline"`
}

func (s *Server) createWorkflow(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeProblem(w, r, s.log, problemBadRequest("IDEMPOTENCY_KEY_REQUIRED", "the Idempotency-Key header is required for workflow creation"))
		return
	}
	if len(key) > 255 {
		writeProblem(w, r, s.log, problemBadRequest("IDEMPOTENCY_KEY_TOO_LONG", "Idempotency-Key must be at most 255 characters"))
		return
	}
	var req createRequest
	if !s.decodeBody(w, r, &req) {
		return
	}
	var fields []FieldError
	if req.DefName == "" || len(req.DefName) > 128 {
		fields = append(fields, FieldError{Field: "def_name", Rule: "required, at most 128 characters"})
	}
	if req.BusinessKey == "" || len(req.BusinessKey) > 255 {
		fields = append(fields, FieldError{Field: "business_key", Rule: "required, at most 255 characters"})
	}
	if req.Deadline == nil {
		fields = append(fields, FieldError{Field: "deadline", Rule: "required RFC3339 timestamp"})
	} else if !req.Deadline.After(time.Now().UTC()) {
		fields = append(fields, FieldError{Field: "deadline", Rule: "must be in the future"})
	}
	if len(fields) > 0 {
		writeProblem(w, r, s.log, problemValidation("create request failed validation", fields...))
		return
	}

	def, err := s.store.GetActiveDefinition(r.Context(), req.DefName)
	if err != nil {
		var dne postgres.DefinitionNotFoundError
		if errors.As(err, &dne) {
			writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/not-found", Title: "Resource not found",
				Status: http.StatusNotFound, Code: "DEFINITION_NOT_FOUND",
				Detail: "no active definition with that name", Extra: map[string]any{"def_name": req.DefName}})
			return
		}
		s.failInternal(w, r, err, "resolve active definition")
		return
	}

	// The store's fingerprint check is the ONLY replay gate. Serving a cached
	// response before it would answer 201-with-replay to a DIFFERENT request
	// that reused the key — silently converting the specified 422
	// IDEMPOTENCY_CONFLICT into a success (an API integration test pinned
	// this: dedup authority lives in the durable layer, the response cache
	// only replays what the store has already vouched for).
	input := req.Input
	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
	out, err := s.store.CreateWorkflow(r.Context(), postgres.CreateParams{
		IdempotencyKey: key,
		DefName:        def.Name,
		DefVersion:     def.Version,
		DefSnapshot:    def.StepsJSON,
		BusinessKey:    req.BusinessKey,
		Input:          input,
		Deadline:       req.Deadline.UTC(),
		Steps:          def.Steps,
	})
	if err != nil {
		var ice postgres.IdempotencyConflictError
		var awe postgres.ActiveWorkflowError
		switch {
		case errors.As(err, &ice):
			writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/conflict", Title: "Idempotency conflict",
				Status: http.StatusUnprocessableEntity, Code: "IDEMPOTENCY_CONFLICT",
				Detail: "this Idempotency-Key was already used with a different create request",
				Extra:  map[string]any{"idempotency_key": key}})
		case errors.As(err, &awe):
			writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/conflict", Title: "Active workflow exists",
				Status: http.StatusConflict, Code: "ACTIVE_WORKFLOW_FOR_KEY",
				Detail: "an active workflow already exists for this business key",
				Extra:  map[string]any{"conflicting_workflow_id": awe.ExistingID}})
		default:
			s.failInternal(w, r, err, "create workflow")
		}
		return
	}

	// Replayed (same key, same fingerprint, verified by the store): serve the
	// FIRST durable response byte-for-byte. The cache can be empty when the
	// first creator crashed between commit and record, or a concurrent winner
	// has not recorded yet — rendering from the durable row then recording
	// closes the gap for the next replay (DATA §D).
	if out.Replayed {
		status, body, headers, found, err := s.store.GetStoredResponse(r.Context(), key, time.Now())
		if err != nil {
			s.failInternal(w, r, err, "read stored response")
			return
		}
		if found {
			var hm map[string]string
			if json.Unmarshal(headers, &hm) == nil {
				for k, v := range hm {
					w.Header().Set(k, v)
				}
			}
			w.Header().Set("Idempotency-Replayed", "true")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write(body)
			return
		}
	}

	// 201 body = the durable row, not an echo of the request.
	view, err := s.store.GetWorkflowDetail(r.Context(), out.Workflow.ID)
	if err != nil {
		s.failInternal(w, r, err, "read back created workflow")
		return
	}
	respBody, err := json.Marshal(toWorkflowDTO(view))
	if err != nil {
		s.failInternal(w, r, err, "render created workflow")
		return
	}
	loc := "/v1/workflows/" + out.Workflow.ID
	hdrs, _ := json.Marshal(map[string]string{"Location": loc, "Content-Type": "application/json"})
	if err := s.store.RecordStoredResponse(r.Context(), key, http.StatusCreated, respBody, hdrs); err != nil {
		// The create itself is durable; only the replay cache is missing.
		s.log.Error("api: record stored response failed", "err", err, "request_id", requestID(r.Context()))
	}
	if out.Replayed {
		// No recorded response yet (creator crashed after commit, or the
		// concurrent winner has not recorded): honest header, same content.
		w.Header().Set("Idempotency-Replayed", "true")
	}
	w.Header().Set("Location", loc)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write(respBody)
}

// ---- workflow reads ----------------------------------------------------------

func (s *Server) workflowIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	idStr := r.PathValue("id")
	if !validUUID(idStr) {
		writeProblem(w, r, s.log, problemBadRequest("INVALID_ID", "workflow id must be a UUID"))
		return "", false
	}
	return idStr, true
}

// requireWorkflowExists turns a detail read into the 404 gate the contract
// demands for the sub-lists, while keeping storage faults 500 (DS-13).
func (s *Server) requireWorkflowExists(w http.ResponseWriter, r *http.Request, idStr string) bool {
	_, err := s.store.GetWorkflowDetail(r.Context(), idStr)
	if err != nil {
		var nfe postgres.NotFoundError
		if errors.As(err, &nfe) {
			writeProblem(w, r, s.log, problemNotFound("WORKFLOW", idStr))
		} else {
			s.failInternal(w, r, err, "workflow existence read")
		}
		return false
	}
	return true
}

func (s *Server) getWorkflow(w http.ResponseWriter, r *http.Request) {
	idStr, ok := s.workflowIDParam(w, r)
	if !ok {
		return
	}
	view, err := s.store.GetWorkflowDetail(r.Context(), idStr)
	if err != nil {
		var nfe postgres.NotFoundError
		if errors.As(err, &nfe) {
			writeProblem(w, r, s.log, problemNotFound("WORKFLOW", idStr))
		} else {
			s.failInternal(w, r, err, "workflow detail read")
		}
		return
	}
	writeJSON(w, http.StatusOK, toWorkflowDTO(view))
}

func (s *Server) listWorkflows(w http.ResponseWriter, r *http.Request) {
	limit, p := parseLimit(r)
	if p.Status != 0 {
		writeProblem(w, r, s.log, p)
		return
	}
	cur, p := decodeCursor(r)
	if p.Status != 0 {
		writeProblem(w, r, s.log, p)
		return
	}
	if cur != "" && !validUUID(cur) {
		writeProblem(w, r, s.log, problemBadRequest("INVALID_CURSOR", "cursor does not decode to a workflow id"))
		return
	}
	q := r.URL.Query()
	state := q.Get("state")
	if state != "" && !listStates[state] {
		writeProblem(w, r, s.log, problemValidation("unknown state filter", FieldError{Field: "state", Rule: "one of the machine's workflow states"}))
		return
	}
	items, err := s.store.ListWorkflows(r.Context(), state, q.Get("business_key"), cur, limit)
	if err != nil {
		s.failInternal(w, r, err, "workflow list")
		return
	}
	writeJSON(w, http.StatusOK, page(items, len(items), limit, func(i int) string { return items[i].ID }))
}

func (s *Server) listEvents(w http.ResponseWriter, r *http.Request) {
	idStr, ok := s.workflowIDParam(w, r)
	if !ok {
		return
	}
	if !s.requireWorkflowExists(w, r, idStr) {
		return
	}
	limit, p := parseLimit(r)
	if p.Status != 0 {
		writeProblem(w, r, s.log, p)
		return
	}
	cur, p := decodeCursor(r)
	if p.Status != 0 {
		writeProblem(w, r, s.log, p)
		return
	}
	afterSeq := int64(-1)
	if cur != "" {
		n, err := strconv.ParseInt(cur, 10, 64)
		if err != nil || n < 0 {
			writeProblem(w, r, s.log, problemBadRequest("INVALID_CURSOR", "event cursor must decode to a sequence number"))
			return
		}
		afterSeq = n
	}
	items, err := s.store.ListAudit(r.Context(), idStr, afterSeq, limit)
	if err != nil {
		s.failInternal(w, r, err, "audit list")
		return
	}
	dtos := make([]auditDTO, len(items))
	for i, a := range items {
		dtos[i] = auditDTO{Seq: a.Seq, Kind: a.Kind, FromState: a.FromState, ToState: a.ToState,
			ReasonCode: a.ReasonCode, Detail: rawJSON(a.Detail), TraceID: a.TraceID, CreatedAt: a.CreatedAt}
	}
	writeJSON(w, http.StatusOK, page(dtos, len(items), limit, func(i int) string { return strconv.FormatInt(items[i].Seq, 10) }))
}

func (s *Server) listInbound(w http.ResponseWriter, r *http.Request) {
	idStr, ok := s.workflowIDParam(w, r)
	if !ok {
		return
	}
	if !s.requireWorkflowExists(w, r, idStr) {
		return
	}
	limit, p := parseLimit(r)
	if p.Status != 0 {
		writeProblem(w, r, s.log, p)
		return
	}
	cur, p := decodeCursor(r)
	if p.Status != 0 {
		writeProblem(w, r, s.log, p)
		return
	}
	var afterTime time.Time
	var afterID string
	if cur != "" {
		var err error
		afterTime, afterID, err = splitTimeCursor(cur)
		if err != nil || !validUUID(afterID) {
			writeProblem(w, r, s.log, problemBadRequest("INVALID_CURSOR", "inbound cursor must decode to \"RFC3339Nano|event-id\""))
			return
		}
	}
	items, err := s.store.ListInbound(r.Context(), idStr, afterTime, afterID, limit)
	if err != nil {
		s.failInternal(w, r, err, "inbound list")
		return
	}
	dtos := make([]inboundDTO, len(items))
	for i, it := range items {
		dtos[i] = inboundDTO{EventID: it.EventID, StepType: it.StepType, Attempt: it.Attempt,
			ReceivedAt: it.ReceivedAt, Classification: it.Classification, Raw: rawJSON(it.Raw)}
	}
	writeJSON(w, http.StatusOK, page(dtos, len(items), limit,
		func(i int) string { return items[i].ReceivedAt.Format(time.RFC3339Nano) + "|" + items[i].EventID }))
}

func (s *Server) listAttempts(w http.ResponseWriter, r *http.Request) {
	idStr, ok := s.workflowIDParam(w, r)
	if !ok {
		return
	}
	if !s.requireWorkflowExists(w, r, idStr) {
		return
	}
	items, err := s.store.ListAttempts(r.Context(), idStr)
	if err != nil {
		s.failInternal(w, r, err, "attempt list")
		return
	}
	dtos := make([]attemptDTO, len(items))
	for i, a := range items {
		dtos[i] = attemptDTO{StepType: a.StepType, Number: a.Number, State: a.State,
			ErrorClass: a.ErrorClass, ErrorDetail: rawJSON(a.ErrorDetail), StartedAt: a.StartedAt, FinishedAt: a.FinishedAt}
	}
	writeJSON(w, http.StatusOK, listResponse{Items: dtos}) // bounded by steps×attempts; §B pages no attempt lists
}

// ---- operator actions ---------------------------------------------------------

type actionRequest struct {
	Reason  string `json:"reason"`
	Version *int64 `json:"version"`
}

// parseActionRequest enforces the shape every state-advancing verb shares.
// `version` is required: the §B table omits it, but optimistic concurrency
// (REQ-C-3) cannot be honoured without the client's observed version — the
// deviation is documented, and a race answers 409 CONFLICT_RETRY carrying
// the current version so the retry is one read away.
func (s *Server) parseActionRequest(w http.ResponseWriter, r *http.Request) (actionRequest, bool) {
	var req actionRequest
	if !s.decodeBody(w, r, &req) {
		return req, false
	}
	var fields []FieldError
	if strings.TrimSpace(req.Reason) == "" || len(req.Reason) > 2000 {
		fields = append(fields, FieldError{Field: "reason", Rule: "required, 1..2000 characters"})
	}
	if req.Version == nil || *req.Version < 1 {
		fields = append(fields, FieldError{Field: "version", Rule: "required, the version read from the workflow"})
	}
	if len(fields) > 0 {
		writeProblem(w, r, s.log, problemValidation("action request failed validation", fields...))
		return req, false
	}
	return req, true
}

// failAction is the DS-13 error table for every state-advancing verb.
// conflictCode names the machine-refusal code for this verb (stable, §B).
func (s *Server) failAction(w http.ResponseWriter, r *http.Request, err error, idStr, conflictCode string) {
	var nfe postgres.NotFoundError
	var ce postgres.ConflictError
	var tie engine.TerminalImmutableError
	var ite engine.InvalidTransitionError
	switch {
	case errors.As(err, &nfe):
		writeProblem(w, r, s.log, problemNotFound("WORKFLOW", idStr))
	case errors.As(err, &ce):
		v := ce.Actual
		writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/conflict", Title: "Version conflict",
			Status: http.StatusConflict, Code: "CONFLICT_RETRY", Version: &v,
			Detail: "the workflow advanced since the version you sent; retry against the current version"})
	case errors.As(err, &tie):
		writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/conflict", Title: "Action refused",
			Status: http.StatusConflict, Code: conflictCode,
			Detail: "the workflow is terminal (" + string(tie.State) + ") and immutable"})
	case errors.As(err, &ite):
		writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/conflict", Title: "Action refused",
			Status: http.StatusConflict, Code: conflictCode, Detail: ite.Reason})
	default:
		s.failInternal(w, r, err, "operator action")
	}
}

// actionResult is the honest 202 payload: the durable verdict of the
// transition, not an echo of the request. Execution continues async.
type actionResult struct {
	ID      string `json:"id"`
	State   string `json:"state"`
	Version int64  `json:"version"`
}

func (s *Server) cancelWorkflow(w http.ResponseWriter, r *http.Request) {
	idStr, ok := s.workflowIDParam(w, r)
	if !ok {
		return
	}
	req, ok := s.parseActionRequest(w, r)
	if !ok {
		return
	}
	op := operatorFrom(r)
	op.Reason = req.Reason
	wf, err := s.store.Cancel(r.Context(), idStr, *req.Version, op)
	if err != nil {
		s.failAction(w, r, err, idStr, "NOT_CANCELLABLE")
		return
	}
	writeJSON(w, http.StatusAccepted, actionResult{ID: wf.ID, State: string(wf.State), Version: wf.Version})
}

func (s *Server) retryNow(w http.ResponseWriter, r *http.Request) {
	idStr, ok := s.workflowIDParam(w, r)
	if !ok {
		return
	}
	req, ok := s.parseActionRequest(w, r)
	if !ok {
		return
	}
	op := operatorFrom(r)
	op.Reason = req.Reason
	wf, err := s.store.RetryNow(r.Context(), idStr, *req.Version, op)
	if err != nil {
		s.failAction(w, r, err, idStr, "NOT_RETRYABLE")
		return
	}
	writeJSON(w, http.StatusAccepted, actionResult{ID: wf.ID, State: string(wf.State), Version: wf.Version})
}

// ---- DLQ ----------------------------------------------------------------------

func (s *Server) listDeadLetters(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	openOnly := true
	if v := q.Get("open"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			writeProblem(w, r, s.log, problemBadRequest("INVALID_PARAM", "open must be a boolean"))
			return
		}
		openOnly = b
	}
	class := q.Get("class")
	if class != "" && (len(class) > 64 || strings.ContainsAny(class, " \t")) {
		writeProblem(w, r, s.log, problemBadRequest("INVALID_PARAM", "class is an exact stable identifier"))
		return
	}
	wfID := q.Get("workflow_id")
	if wfID != "" && !validUUID(wfID) {
		writeProblem(w, r, s.log, problemBadRequest("INVALID_PARAM", "workflow_id must be a UUID"))
		return
	}
	limit, p := parseLimit(r)
	if p.Status != 0 {
		writeProblem(w, r, s.log, p)
		return
	}
	cur, p := decodeCursor(r)
	if p.Status != 0 {
		writeProblem(w, r, s.log, p)
		return
	}
	var afterTime time.Time
	var afterID string
	if cur != "" {
		var err error
		afterTime, afterID, err = splitTimeCursor(cur)
		if err != nil || !validUUID(afterID) {
			writeProblem(w, r, s.log, problemBadRequest("INVALID_CURSOR", "dlq cursor must decode to \"RFC3339Nano|id\""))
			return
		}
	}
	items, err := s.store.ListDeadLetters(r.Context(), openOnly, class, wfID, afterTime, afterID, limit)
	if err != nil {
		s.failInternal(w, r, err, "dlq list")
		return
	}
	dtos := make([]deadLetterDTO, len(items))
	for i, d := range items {
		dtos[i] = deadLetterDTO{ID: d.ID, WorkflowID: d.WorkflowID, StepType: d.StepType, Attempt: d.Attempt,
			Class: d.Class, ReasonCode: d.ReasonCode, Detail: rawJSON(d.Detail), CreatedAt: d.CreatedAt,
			ResolvedAt: d.ResolvedAt, ResolvedBy: d.ResolvedBy, Resolution: d.Resolution}
	}
	writeJSON(w, http.StatusOK, page(dtos, len(items), limit,
		func(i int) string { return items[i].CreatedAt.Format(time.RFC3339Nano) + "|" + items[i].ID }))
}

type resolveRequest struct {
	Action string `json:"action"`
	Reason string `json:"reason"`
	DryRun bool   `json:"dry_run"`
}

func (s *Server) resolveDeadLetter(w http.ResponseWriter, r *http.Request) {
	dlID := r.PathValue("id")
	if !validUUID(dlID) {
		writeProblem(w, r, s.log, problemBadRequest("INVALID_ID", "dead-letter id must be a UUID"))
		return
	}
	var req resolveRequest
	if !s.decodeBody(w, r, &req) {
		return
	}
	switch req.Action {
	case string(engine.ForceTerminate), string(engine.CompleteCompensation):
	case "retry-now":
		// §B lists retry-now under resolve, but the machine admits only two
		// W17 exits from FAILED_MANUAL. Immediate re-issue is W18 and lives
		// on the workflow resource — deviation documented in the validation
		// report; this answer teaches the correct shape rather than faking it.
		writeProblem(w, r, s.log, problemValidation(
			"retry-now is not a dead-letter resolution; use POST /v1/workflows/{id}/actions:retry-now on a RETRY_WAITING workflow",
			FieldError{Field: "action", Rule: "force-terminate | complete-compensation"}))
		return
	default:
		writeProblem(w, r, s.log, problemValidation("unknown resolve action",
			FieldError{Field: "action", Rule: "force-terminate | complete-compensation"}))
		return
	}
	if strings.TrimSpace(req.Reason) == "" || len(req.Reason) > 2000 {
		writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/validation", Title: "Validation failed",
			Status: http.StatusUnprocessableEntity, Code: "REASON_REQUIRED",
			Detail: "every operator resolution needs a recorded reason (1..2000 characters)"})
		return
	}
	op := operatorFrom(r)
	op.Reason = req.Reason
	wf, err := s.store.ResolveDeadLetter(r.Context(), dlID, engine.ManualAction(req.Action), op, req.DryRun)
	if err != nil {
		var dne postgres.DeadLetterNotFoundError
		var dre postgres.DeadLetterResolvedError
		var ce postgres.ConflictError
		var nfe postgres.NotFoundError
		var tie engine.TerminalImmutableError
		var ite engine.InvalidTransitionError
		switch {
		case errors.As(err, &dne):
			writeProblem(w, r, s.log, problemNotFound("DEAD_LETTER", dlID))
		case errors.As(err, &dre):
			writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/conflict", Title: "Already resolved",
				Status: http.StatusConflict, Code: "ALREADY_RESOLVED", Detail: "this dead-letter item is closed",
				Extra: map[string]any{"dead_letter_id": dlID}})
		case errors.As(err, &ce):
			v := ce.Actual
			writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/conflict", Title: "Version conflict",
				Status: http.StatusConflict, Code: "CONFLICT_RETRY", Version: &v,
				Detail: "the workflow advanced since the version you read; retry against the current version"})
		case errors.As(err, &nfe):
			writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/not-found", Title: "Resource not found",
				Status: http.StatusNotFound, Code: "WORKFLOW_NOT_FOUND",
				Detail: "the workflow referenced by this dead-letter item no longer exists"})
		case errors.As(err, &tie):
			writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/conflict", Title: "Action refused",
				Status: http.StatusConflict, Code: "NOT_RESOLVABLE",
				Detail: "the workflow is terminal (" + string(tie.State) + ") and immutable"})
		case errors.As(err, &ite):
			writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/conflict", Title: "Action refused",
				Status: http.StatusConflict, Code: "NOT_RESOLVABLE", Detail: ite.Reason})
		default:
			s.failInternal(w, r, err, "dlq resolve")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"dead_letter_id": dlID, "workflow_id": wf.ID, "state": string(wf.State),
		"version": wf.Version, "dry_run": req.DryRun,
	})
}

// ---- definitions ---------------------------------------------------------------

func (s *Server) listDefinitions(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if len(name) > 128 {
		writeProblem(w, r, s.log, problemBadRequest("INVALID_PARAM", "name filter too long"))
		return
	}
	items, err := s.store.ListDefinitions(r.Context(), name)
	if err != nil {
		s.failInternal(w, r, err, "definition list")
		return
	}
	dtos := make([]definitionDTO, len(items))
	for i, d := range items {
		dtos[i] = toDefinitionDTO(d)
	}
	writeJSON(w, http.StatusOK, listResponse{Items: dtos}) // definition sets are small; §B pages none
}

type registerDefinitionRequest struct {
	Name    string          `json:"name"`
	Version int             `json:"version"`
	Steps   json.RawMessage `json:"steps"`
}

func (s *Server) registerDefinition(w http.ResponseWriter, r *http.Request) {
	var req registerDefinitionRequest
	if !s.decodeBody(w, r, &req) {
		return
	}
	var fields []FieldError
	if req.Name == "" || len(req.Name) > 128 {
		fields = append(fields, FieldError{Field: "name", Rule: "required, at most 128 characters"})
	}
	if req.Version < 1 {
		fields = append(fields, FieldError{Field: "version", Rule: "required, >= 1"})
	}
	if len(req.Steps) == 0 {
		fields = append(fields, FieldError{Field: "steps", Rule: "required, the step document"})
	}
	if len(fields) > 0 {
		writeProblem(w, r, s.log, problemValidation("definition registration failed validation", fields...))
		return
	}
	def, err := s.store.RegisterDefinition(r.Context(), req.Name, req.Version, req.Steps)
	if err != nil {
		var de postgres.DefinitionError
		var dce postgres.DefinitionConflictError
		switch {
		case errors.As(err, &de):
			writeProblem(w, r, s.log, problemValidation("the step document is invalid: "+de.Reason))
		case errors.As(err, &dce):
			writeProblem(w, r, s.log, Problem{Type: "https://fathom.dev/errors/conflict", Title: "Definition exists",
				Status: http.StatusConflict, Code: "DEFINITION_EXISTS",
				Detail: "definitions are immutable; register a new version instead",
				Extra:  map[string]any{"name": dce.Name, "version": dce.Version}})
		default:
			s.failInternal(w, r, err, "definition registration")
		}
		return
	}
	w.Header().Set("Location", "/v1/definitions?name="+def.Name)
	writeJSON(w, http.StatusCreated, toDefinitionDTO(def))
}
