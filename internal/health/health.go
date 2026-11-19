// Package health serves the process liveness/readiness surface (ADR-015,
// checklist D7): /healthz is a pure liveness answer and NEVER touches the
// database (a DB outage must not look like a dead process to a load balancer
// that then restarts everything in a loop), /readyz is the honest gate:
// database reachable AND the outbox backlog younger than the configured
// relay-lag threshold. Responses carry stable reason codes, never DSNs,
// error strings, or payload data.
package health

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	postgres "github.com/lakhyach/fathom/internal/store/postgres"
)

// Check bundles the readiness parameters.
type Check struct {
	store        *postgres.Store
	maxOutboxAge time.Duration // readyz relay-lag threshold (SM §8 backlog bound)
	log          *slog.Logger
}

func New(store *postgres.Store, maxOutboxAge time.Duration, log *slog.Logger) (*Check, error) {
	if store == nil {
		return nil, errors.New("health: store required")
	}
	if maxOutboxAge <= 0 {
		maxOutboxAge = 5 * time.Minute
	}
	if log == nil {
		log = slog.Default()
	}
	return &Check{store: store, maxOutboxAge: maxOutboxAge, log: log.With("component", "health")}, nil
}

// Healthz answers without touching any dependency.
func (h *Check) Healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// Readyz reports ready only while both real gates hold. Order matters: with
// no database there is nothing to measure, so db_unavailable is the first
// verdict. Relay lag: the OLDEST unpublished outbox row past the threshold
// means the relay lane is not keeping up — the process must not be advertised
// as ready to add more load in that state (it is also the exit-gate style
// signal OBSERVABILITY §2 asks /readyz to carry).
func (h *Check) Readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	if err := h.store.Pool().Ping(ctx); err != nil {
		h.log.Warn("readyz: database unreachable", "err", redactErr(err))
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "unavailable", "reason": "db_unavailable"})
		return
	}
	_, oldestAge, err := h.store.OutboxPending(ctx)
	if err != nil {
		h.log.Warn("readyz: backlog read failed", "err", redactErr(err))
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "unavailable", "reason": "db_unavailable"})
		return
	}
	if oldestAge > h.maxOutboxAge.Seconds() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "unavailable", "reason": "relay_lag"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

// redactErr keeps readiness logs useful but payload-free (brief §8: no
// sensitive material in operational output; connection errors can embed host
// hints, so only the class is logged).
func redactErr(err error) string { return "database error (details suppressed)" }

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}
