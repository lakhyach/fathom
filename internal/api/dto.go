package api

import (
	"encoding/json"
	"time"

	postgres "github.com/lakhyach/fathom/internal/store/postgres"
)

// Wire DTOs. The store views carry JSONB columns as []byte, which encoding/json
// would base64 — these types re-type exactly those fields as json.RawMessage so
// payloads ride the wire as JSON objects (nothing else about the shapes changes).

type workflowDTO struct {
	ID            string              `json:"id"`
	DefName       string              `json:"def_name"`
	DefVersion    int                 `json:"def_version"`
	DefSnapshot   json.RawMessage     `json:"def_snapshot"`
	State         string              `json:"state"`
	Version       int64               `json:"version"`
	BusinessKey   string              `json:"business_key"`
	Input         json.RawMessage     `json:"input"`
	DeadlineAt    time.Time           `json:"deadline_at"`
	NextAttemptAt *time.Time          `json:"next_attempt_at"`
	CreatedAt     time.Time           `json:"created_at"`
	UpdatedAt     time.Time           `json:"updated_at"`
	StartedAt     *time.Time          `json:"started_at"`
	FinishedAt    *time.Time          `json:"finished_at"`
	Steps         []postgres.StepView `json:"steps"`
}

func toWorkflowDTO(v postgres.WorkflowView) workflowDTO {
	return workflowDTO{
		ID: v.ID, DefName: v.DefName, DefVersion: v.DefVersion,
		DefSnapshot: rawJSON(v.DefSnapshot), State: v.State, Version: v.Version,
		BusinessKey: v.BusinessKey, Input: rawJSON(v.Input), DeadlineAt: v.DeadlineAt,
		NextAttemptAt: v.NextAttemptAt, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt,
		StartedAt: v.StartedAt, FinishedAt: v.FinishedAt, Steps: v.Steps,
	}
}

type auditDTO struct {
	Seq        int64           `json:"seq"`
	Kind       string          `json:"kind"`
	FromState  *string         `json:"from_state"`
	ToState    string          `json:"to_state"`
	ReasonCode string          `json:"reason_code"`
	Detail     json.RawMessage `json:"detail"`
	TraceID    *string         `json:"trace_id"`
	CreatedAt  time.Time       `json:"created_at"`
}

type inboundDTO struct {
	EventID        string          `json:"event_id"`
	StepType       *string         `json:"step_type"`
	Attempt        *int            `json:"attempt"`
	ReceivedAt     time.Time       `json:"received_at"`
	Classification *string         `json:"classification"`
	Raw            json.RawMessage `json:"raw"`
}

type attemptDTO struct {
	StepType    string          `json:"step_type"`
	Number      int             `json:"number"`
	State       string          `json:"state"`
	ErrorClass  *string         `json:"error_class"`
	ErrorDetail json.RawMessage `json:"error_detail"`
	StartedAt   time.Time       `json:"started_at"`
	FinishedAt  *time.Time      `json:"finished_at"`
}

type deadLetterDTO struct {
	ID         string          `json:"id"`
	WorkflowID string          `json:"workflow_id"`
	StepType   *string         `json:"step_type"`
	Attempt    *int            `json:"attempt"`
	Class      string          `json:"class"`
	ReasonCode string          `json:"reason_code"`
	Detail     json.RawMessage `json:"detail"`
	CreatedAt  time.Time       `json:"created_at"`
	ResolvedAt *time.Time      `json:"resolved_at"`
	ResolvedBy *string         `json:"resolved_by"`
	Resolution *string         `json:"resolution"`
}

type definitionDTO struct {
	Name      string          `json:"name"`
	Version   int             `json:"version"`
	Status    string          `json:"status"`
	Steps     json.RawMessage `json:"steps"`
	CreatedAt time.Time       `json:"created_at"`
}

func toDefinitionDTO(d postgres.Definition) definitionDTO {
	return definitionDTO{Name: d.Name, Version: d.Version, Status: d.Status,
		Steps: rawJSON(d.StepsJSON), CreatedAt: d.CreatedAt}
}
