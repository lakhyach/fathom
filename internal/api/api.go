package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/lakhyach/fathom/internal/health"
	"github.com/lakhyach/fathom/internal/id"
	"github.com/lakhyach/fathom/internal/metrics"
	postgres "github.com/lakhyach/fathom/internal/store/postgres"
)

// Defaults fixed by DATA §B: page size 25 (cap 100), request bodies 1 MiB,
// rate budget 100 req/min per key.
const (
	defaultLimit = 25
	maxLimit     = 100
	defaultBody  = 1 << 20
)

// Server owns the Phase-5 REST surface. One store, one key set, one logger;
// the health and metrics lanes are constructed here so /readyz and /metrics
// always describe THIS process' real dependencies (brief §8).
type Server struct {
	store   *postgres.Store
	keys    *Keys
	log     *slog.Logger
	health  *health.Check
	metrics http.Handler
	limiter *RateLimiter
	maxBody int64

	readyMaxOutboxAge time.Duration // Option-fed; ≤0 => health default
}

// Option tunes a Server at construction. Keeping these variadic preserves the
// plain New(store, keys, log) call sites (tests) while letting cmd/fathom pass
// operator-configured thresholds instead of compiled defaults.
type Option func(*Server)

// WithReadyMaxOutboxAge overrides the /readyz relay-lag threshold; values ≤0
// fall back to the health package's documented default.
func WithReadyMaxOutboxAge(d time.Duration) Option {
	return func(s *Server) { s.readyMaxOutboxAge = d }
}

func New(store *postgres.Store, keys *Keys, log *slog.Logger, opts ...Option) (*Server, error) {
	if store == nil {
		return nil, errors.New("api: store required")
	}
	if keys == nil {
		return nil, errors.New("api: keys required (the local-only boundary still needs at least one)")
	}
	if log == nil {
		log = slog.Default()
	}
	s := &Server{
		store:   store,
		keys:    keys,
		log:     log.With("component", "api"),
		limiter: NewRateLimiter(defaultRateLimit, time.Minute),
		maxBody: defaultBody,
	}
	for _, opt := range opts {
		opt(s)
	}
	hc, err := health.New(store, s.readyMaxOutboxAge, s.log) // ≤0 => documented 5m relay-lag threshold
	if err != nil {
		return nil, err
	}
	s.health = hc
	mh, _ := metrics.Handler(store, s.log)
	s.metrics = mh
	return s, nil
}

const defaultRateLimit = 100

// Handler assembles the routing and middleware layers. Ordering (outermost
// first): request-id stamping → bearer authentication → per-key rate budget →
// method+path routing → per-route role gate. The infra endpoints are the one
// documented exception to authentication: probes and scrapers answer to
// loopback only while LoopbackOnly guards the bind.
func (s *Server) Handler() http.Handler {
	v1 := http.NewServeMux()
	v1.HandleFunc("POST /v1/workflows", Require(RoleOperator, s.createWorkflow, s.log))
	v1.HandleFunc("GET /v1/workflows", Require(RoleReader, s.listWorkflows, s.log))
	v1.HandleFunc("GET /v1/workflows/{id}", Require(RoleReader, s.getWorkflow, s.log))
	v1.HandleFunc("GET /v1/workflows/{id}/events", Require(RoleReader, s.listEvents, s.log))
	v1.HandleFunc("GET /v1/workflows/{id}/inbound", Require(RoleReader, s.listInbound, s.log))
	v1.HandleFunc("GET /v1/workflows/{id}/attempts", Require(RoleReader, s.listAttempts, s.log))
	v1.HandleFunc("POST /v1/workflows/{id}/actions:cancel", Require(RoleOperator, s.cancelWorkflow, s.log))
	v1.HandleFunc("POST /v1/workflows/{id}/actions:retry-now", Require(RoleOperator, s.retryNow, s.log))
	v1.HandleFunc("GET /v1/dlq", Require(RoleReader, s.listDeadLetters, s.log))
	v1.HandleFunc("POST /v1/dlq/{id}/actions:resolve", Require(RoleOperator, s.resolveDeadLetter, s.log))
	v1.HandleFunc("GET /v1/definitions", Require(RoleReader, s.listDefinitions, s.log))
	v1.HandleFunc("POST /v1/definitions", Require(RoleAdmin, s.registerDefinition, s.log))
	// steps/{t}/actions:abandon (DATA §B) is NOT served: the machine has no
	// abandon transition (W1–W18), and the API will not fake one by relabelling
	// a timeout. Deferred with a new transition to a later phase — deviation
	// recorded in PHASE_5_VALIDATION_REPORT.

	root := http.NewServeMux()
	root.HandleFunc("GET /healthz", s.health.Healthz)
	root.HandleFunc("GET /readyz", s.health.Readyz)
	root.Handle("GET /metrics", s.metrics)
	root.Handle("/v1/", s.keys.Authn(s.limiter.Middleware(v1, s.log), s.log))
	return s.withRequestID(root)
}

// withRequestID stamps every response with a uuidv7 trace id. A client-
// supplied X-Request-Id is honoured only when it is short and printable —
// it becomes a header echo and log field, never a database value here.
func (s *Server) withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rid := r.Header.Get("X-Request-Id")
		if rid == "" || len(rid) > 64 || strings.ContainsAny(rid, "\r\n\t") {
			rid = id.New()
		}
		w.Header().Set("X-Request-Id", rid)
		ctx := context.WithValue(r.Context(), ctxRequestID, rid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ---- request helpers -------------------------------------------------------

// decodeBody reads at most maxBody bytes of a single strict JSON object.
// Unknown fields and trailing garbage are 400s, not silent accepts.
func (s *Server) decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, s.maxBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeProblem(w, r, s.log, problemBadRequest("REQUEST_TOO_LARGE", "request body exceeds the configured limit"))
		} else {
			writeProblem(w, r, s.log, problemBadRequest("MALFORMED_JSON", "body must be one valid JSON object: "+err.Error()))
		}
		return false
	}
	if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		writeProblem(w, r, s.log, problemBadRequest("TRAILING_BODY", "exactly one JSON object must be sent"))
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// parseLimit: contract default 25, hard cap 100 (brief §9 bounded batches).
func parseLimit(r *http.Request) (int, Problem) {
	q := r.URL.Query().Get("limit")
	if q == "" {
		return defaultLimit, Problem{}
	}
	n, err := strconv.Atoi(q)
	if err != nil || n < 1 || n > maxLimit {
		return 0, problemBadRequest("INVALID_LIMIT", "limit must be an integer in [1,100]")
	}
	return n, Problem{}
}

// Cursors are opaque base64url strings over the keyset tail the store pages
// by (DATA §B): workflows = last id; events = last audit seq; inbound and
// DLQ = "RFC3339Nano|id". A cursor that does not decode is a client bug.
func encodeCursor(v string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(v))
}

func decodeCursor(r *http.Request) (string, Problem) {
	c := r.URL.Query().Get("cursor")
	if c == "" {
		return "", Problem{}
	}
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return "", problemBadRequest("INVALID_CURSOR", "cursor is opaque; resend the value from a previous page")
	}
	return string(b), Problem{}
}

// splitTimeCursor decodes the composite (timestamp, id) cursor.
func splitTimeCursor(raw string) (time.Time, string, error) {
	i := strings.LastIndexByte(raw, '|')
	if i <= 0 || i == len(raw)-1 {
		return time.Time{}, "", errors.New("malformed composite cursor")
	}
	ts, err := time.Parse(time.RFC3339Nano, raw[:i])
	if err != nil {
		return time.Time{}, "", errors.New("malformed cursor timestamp")
	}
	return ts, raw[i+1:], nil
}

func validUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
}

// rawJSON re-types a JSONB []byte for the wire so it marshals as JSON, not
// base64. NULL/absent becomes JSON null.
func rawJSON(b []byte) json.RawMessage {
	if len(b) == 0 {
		return nil
	}
	return json.RawMessage(b)
}

// listResponse is the §B paging envelope.
type listResponse struct {
	Items      any     `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

func page(items any, n int, limit int, cursorOf func(int) string) listResponse {
	out := listResponse{Items: items}
	if n == limit {
		c := encodeCursor(cursorOf(n - 1))
		out.NextCursor = &c
	}
	return out
}
