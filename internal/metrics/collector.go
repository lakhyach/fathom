// Package metrics exposes the Phase-5 Prometheus surface (OBSERVABILITY §2
// normative names, ADR-015, brief §8). Every series is collected from the
// database's own durable truth at scrape time — there are no process-local
// counters here pretending to be the system, and nothing wired that real
// operations do not move (checklist M-T1). Counters derived from append-only
// tables (audit_event, inbound_event) only ever grow, so they are honest
// counters across restarts, shared by every replica that scrapes the same
// database.
//
// Deliberately NOT wired yet (no dead gauges): the attempt-duration histogram
// and idempotency/operator counters belong to the OTel-depth observability
// phase (checklist §2.8); this phase ships the set that today's real
// operations actually produce.
package metrics

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	postgres "github.com/Lakhyajit-96/fathom/internal/store/postgres"
)

// Collector reads one MetricsSnapshot per scrape.
type Collector struct {
	store *postgres.Store
	log   *slog.Logger

	descWorkflows   *prometheus.Desc
	descTransitions *prometheus.Desc
	descOldestOpen  *prometheus.Desc
	descClassified  *prometheus.Desc
	descOutboxDepth *prometheus.Desc
	descOutboxAge   *prometheus.Desc
	descRelayLag    *prometheus.Desc
	descRelayRows   *prometheus.Desc
	descDLQDepth    *prometheus.Desc
	descDLQOldest   *prometheus.Desc
	descLeasesHeld  *prometheus.Desc
}

// NewCollector builds the collector; register it with a prometheus.Registry.
func NewCollector(store *postgres.Store, log *slog.Logger) *Collector {
	if log == nil {
		log = slog.Default()
	}
	return &Collector{store: store, log: log.With("component", "metrics"),
		descWorkflows: prometheus.NewDesc("fathom_workflows_total",
			"Workflows by definition and state (durable census).",
			[]string{"def_name", "state"}, nil),
		descTransitions: prometheus.NewDesc("fathom_workflow_transitions_total",
			"Applied machine transitions by edge (append-only audit derivation).",
			[]string{"from", "to", "reason_code"}, nil),
		descOldestOpen: prometheus.NewDesc("fathom_oldest_open_workflow_age_seconds",
			"Age of the oldest unfinished workflow (REQ-C-5 exit gate).", nil, nil),
		descClassified: prometheus.NewDesc("fathom_events_classified_total",
			"Inbound events by ingress classification (append-only derivation).",
			[]string{"classification"}, nil),
		descOutboxDepth: prometheus.NewDesc("fathom_outbox_unpublished_count",
			"Outbox rows awaiting publication (excludes dead-lettered).", nil, nil),
		descOutboxAge: prometheus.NewDesc("fathom_outbox_oldest_unpublished_age_seconds",
			"Age of the oldest unpublished outbox row — relay backlog signal.", nil, nil),
		descRelayLag: prometheus.NewDesc("fathom_relay_publish_lag_seconds",
			"Seconds since a relay's last durable ack.", []string{"relay"}, nil),
		descRelayRows: prometheus.NewDesc("fathom_relay_unacked_rows",
			"Deliverable outbox rows beyond a relay's checkpoint.", []string{"relay"}, nil),
		descDLQDepth: prometheus.NewDesc("fathom_dlq_depth",
			"Open dead-letter items by class.", []string{"class"}, nil),
		descDLQOldest: prometheus.NewDesc("fathom_dlq_oldest_age_seconds",
			"Age of the oldest open dead-letter item (0 when none).", nil, nil),
		descLeasesHeld: prometheus.NewDesc("fathom_worker_leases_held",
			"Step leases currently live (held past their workers' claims).", nil, nil),
	}
}

var _ prometheus.Collector = (*Collector)(nil)

// Describe publishes the fixed series set.
func (c *Collector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{c.descWorkflows, c.descTransitions, c.descOldestOpen,
		c.descClassified, c.descOutboxDepth, c.descOutboxAge, c.descRelayLag, c.descRelayRows,
		c.descDLQDepth, c.descDLQOldest, c.descLeasesHeld} {
		ch <- d
	}
}

// Collect scrapes the durable snapshot. A store failure yields ch-empty with
// the error logged: a missing series is honest; a fabricated zero is not.
func (c *Collector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	snap, err := c.store.MetricsSnapshot(ctx)
	if err != nil {
		c.log.Error("metrics scrape failed", "err", err)
		return
	}
	var dlqOldest float64
	for _, w := range snap.Workflows {
		ch <- prometheus.MustNewConstMetric(c.descWorkflows, prometheus.GaugeValue,
			float64(w.Count), w.DefName, w.State)
	}
	for _, t := range snap.Transitions {
		ch <- prometheus.MustNewConstMetric(c.descTransitions, prometheus.CounterValue,
			float64(t.Count), t.FromState, t.ToState, t.ReasonCode)
	}
	ch <- prometheus.MustNewConstMetric(c.descOldestOpen, prometheus.GaugeValue, snap.OldestOpenAgeSec)
	for class, n := range snap.Classified {
		ch <- prometheus.MustNewConstMetric(c.descClassified, prometheus.CounterValue,
			float64(n), class)
	}
	ch <- prometheus.MustNewConstMetric(c.descOutboxDepth, prometheus.GaugeValue, float64(snap.OutboxUnpublished))
	ch <- prometheus.MustNewConstMetric(c.descOutboxAge, prometheus.GaugeValue, snap.OutboxOldestAgeSec)
	for _, r := range snap.Relays {
		ch <- prometheus.MustNewConstMetric(c.descRelayLag, prometheus.GaugeValue,
			r.CheckpointAgeSeconds, r.Name)
		ch <- prometheus.MustNewConstMetric(c.descRelayRows, prometheus.GaugeValue,
			float64(r.LagRows), r.Name)
	}
	for _, d := range snap.DLQ {
		ch <- prometheus.MustNewConstMetric(c.descDLQDepth, prometheus.GaugeValue,
			float64(d.Open), d.Class)
		if d.Open > 0 && d.OldestOpenAgeSec > dlqOldest {
			dlqOldest = d.OldestOpenAgeSec
		}
	}
	ch <- prometheus.MustNewConstMetric(c.descDLQOldest, prometheus.GaugeValue, dlqOldest)
	ch <- prometheus.MustNewConstMetric(c.descLeasesHeld, prometheus.GaugeValue, float64(snap.LeasesHeld))
}

// Handler serves /metrics on its own registry (no global-state pollution, so
// tests scrape cleanly and the process cannot advertise unregistered series).
func Handler(store *postgres.Store, log *slog.Logger) (http.Handler, *prometheus.Registry) {
	reg := prometheus.NewRegistry()
	reg.MustRegister(NewCollector(store, log))
	return promhttp.HandlerFor(reg, promhttp.HandlerOpts{}), reg
}
