// Package api is the minimal Phase-5 REST surface (brief §6, DATA §B):
// idempotent workflow creation, durable reads, operator actions, the DLQ
// console, and the infra endpoints — all answering through RFC 9457
// problem+json with a stable machine code and trace id.
//
// Boundaries honoured, stated plainly:
//
//   - validation happens HERE; the engine is never reached by a malformed
//     request (brief §9.13);
//   - status discipline (DS-13): 404 only for genuinely missing resources,
//     storage faults are 500 + INTERNAL (never disguised as 404), version
//     races are 409 CONFLICT_RETRY carrying the current version;
//   - the authentication boundary is the documented LOCAL-ONLY bearer-key
//     scheme (ADR-013, checklist §2.9): keys from configuration, roles
//     reader|operator|admin, no invented identities, audit actor = the key
//     label. This API MUST NOT be publicly exposed before real authN lands.
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// Problem is the RFC 9457 body plus the two contract fields §B mandates:
// stable `code` and `trace_id`.
type Problem struct {
	Type     string         `json:"type"`
	Title    string         `json:"title"`
	Status   int            `json:"status"`
	Code     string         `json:"code"`
	Detail   string         `json:"detail,omitempty"`
	TraceID  string         `json:"trace_id"`
	Instance string         `json:"instance,omitempty"`
	Errors   []FieldError   `json:"errors,omitempty"`
	Version  *int64         `json:"version,omitempty"` // 409 CONFLICT_RETRY: current durable version
	Extra    map[string]any `json:"-"`
}

type FieldError struct {
	Field string `json:"field"`
	Rule  string `json:"rule"`
}

// writeProblem serialises the error body. It is the ONLY error path out of
// the API; internal detail never leaks: Problem.Detail carries safe,
// operator-facing text chosen at the call site, not wrapped store errors.
func writeProblem(w http.ResponseWriter, r *http.Request, log *slog.Logger, p Problem) {
	p.Instance = r.URL.Path
	if p.TraceID == "" {
		p.TraceID = requestID(r.Context())
	}
	m := map[string]any{
		"type": p.Type, "title": p.Title, "status": p.Status,
		"code": p.Code, "trace_id": p.TraceID, "instance": p.Instance,
	}
	if p.Detail != "" {
		m["detail"] = p.Detail
	}
	if len(p.Errors) > 0 {
		m["errors"] = p.Errors
	}
	if p.Version != nil {
		m["version"] = *p.Version
	}
	for k, v := range p.Extra {
		m[k] = v
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(p.Status)
	if err := json.NewEncoder(w).Encode(m); err != nil {
		log.Error("problem encode failed", "err", err)
	}
}

// problem constructors — the stable code set is exactly DATA §B.
func problemValidation(detail string, fields ...FieldError) Problem {
	return Problem{Type: "https://fathom.dev/errors/validation", Title: "Validation failed",
		Status: http.StatusUnprocessableEntity, Code: "VALIDATION_FAILED", Detail: detail, Errors: fields}
}

func problemBadRequest(code, detail string) Problem {
	return Problem{Type: "https://fathom.dev/errors/bad-request", Title: "Bad request",
		Status: http.StatusBadRequest, Code: code, Detail: detail}
}

func problemNotFound(what, id string) Problem {
	return Problem{Type: "https://fathom.dev/errors/not-found", Title: "Resource not found",
		Status: http.StatusNotFound, Code: what + "_NOT_FOUND", Detail: "no " + what + " exists with the given id",
		Extra: map[string]any{"id": id}}
}

func problemInternal() Problem {
	return Problem{Type: "https://fathom.dev/errors/internal", Title: "Internal error",
		Status: http.StatusInternalServerError, Code: "INTERNAL",
		Detail: "the request could not be completed; the failure is recorded server-side"}
}
