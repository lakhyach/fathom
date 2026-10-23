package postgres

import (
	"context"
)

// Durable-derived numbers for the metrics surface (OBSERVABILITY §2, brief §8,
// checklist D7). Every value comes from append-only or state-truthful tables —
// there is nothing here a process could fake, and nothing wired that does not
// move with real operations. One snapshot per scrape keeps the cost bounded.

// WorkflowCount is one (definition, state) cell of the workflow census.
type WorkflowCount struct {
	DefName string
	State   string
	Count   int64
}

// RelayStat is one relay's durable delivery state. CheckpointAgeSeconds is the
// time since its last acked batch — the honest unit of "publish lag" for a
// poll-based relay (rows between batches also age the pending gauge).
type RelayStat struct {
	Name                 string
	LastSeq              int64
	LagRows              int64
	CheckpointAgeSeconds float64
}

// DLQStat is one dead-letter class: open depth and the age of the oldest open
// item (0 when none).
type DLQStat struct {
	Class            string
	Open             int64
	OldestOpenAgeSec float64
}

// TransitionCount is the durable count of one machine transition edge —
// derived from the append-only audit trail, so it only ever grows (a real
// counter, not a re-invented one).
type TransitionCount struct {
	FromState  string
	ToState    string
	ReasonCode string
	Count      int64
}

// MetricsSnapshot is the complete scrape payload.
type MetricsSnapshot struct {
	Workflows          []WorkflowCount
	OldestOpenAgeSec   float64 // REQ-C-5 exit gate: age of the oldest unfinished workflow
	OutboxUnpublished  int64
	OutboxOldestAgeSec float64
	Relays             []RelayStat
	DLQ                []DLQStat
	Classified         map[string]int64 // inbound_event classification census
	Transitions        []TransitionCount
	LeasesHeld         int64
}

// MetricsSnapshot runs the scrape reads on the database clock. "Open" is
// expressed as finished_at IS NULL — equivalent to non-terminal by the
// schema-enforced terminal_coherence invariant, so no state list is duplicated.
func (s *Store) MetricsSnapshot(ctx context.Context) (*MetricsSnapshot, error) {
	snap := &MetricsSnapshot{Classified: map[string]int64{}}

	rows, err := s.pool.Query(ctx,
		`SELECT def_name, state, count(*) FROM workflow GROUP BY def_name, state`)
	if err != nil {
		return nil, mapQueryErr(err, "metrics workflows census")
	}
	for rows.Next() {
		var w WorkflowCount
		if err := rows.Scan(&w.DefName, &w.State, &w.Count); err != nil {
			rows.Close()
			return nil, mapQueryErr(err, "scan workflows census")
		}
		snap.Workflows = append(snap.Workflows, w)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, mapQueryErr(err, "iterate workflows census")
	}
	rows.Close()

	err = s.pool.QueryRow(ctx,
		`SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::double precision
		   FROM workflow WHERE finished_at IS NULL`).Scan(&snap.OldestOpenAgeSec)
	if err != nil {
		return nil, mapQueryErr(err, "metrics oldest open age")
	}

	err = s.pool.QueryRow(ctx,
		`SELECT count(*),
		        COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::double precision
		   FROM outbox WHERE published_at IS NULL AND failed_at IS NULL`).
		Scan(&snap.OutboxUnpublished, &snap.OutboxOldestAgeSec)
	if err != nil {
		return nil, mapQueryErr(err, "metrics outbox pending")
	}

	rows, err = s.pool.Query(ctx,
		`SELECT r.relay_name, r.last_seq,
		        COALESCE(EXTRACT(EPOCH FROM now() - r.updated_at), 0)::double precision,
		        (SELECT count(*) FROM outbox o
		          WHERE o.seq > r.last_seq AND o.published_at IS NULL AND o.failed_at IS NULL)
		   FROM relay_checkpoint r ORDER BY r.relay_name`)
	if err != nil {
		return nil, mapQueryErr(err, "metrics relay stats")
	}
	for rows.Next() {
		var r RelayStat
		if err := rows.Scan(&r.Name, &r.LastSeq, &r.CheckpointAgeSeconds, &r.LagRows); err != nil {
			rows.Close()
			return nil, mapQueryErr(err, "scan relay stats")
		}
		snap.Relays = append(snap.Relays, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, mapQueryErr(err, "iterate relay stats")
	}
	rows.Close()

	rows, err = s.pool.Query(ctx,
		`SELECT class,
		        count(*) FILTER (WHERE resolved_at IS NULL),
		        COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)
		                         FILTER (WHERE resolved_at IS NULL)), 0)::double precision
		   FROM dead_letter GROUP BY class`)
	if err != nil {
		return nil, mapQueryErr(err, "metrics dlq stats")
	}
	for rows.Next() {
		var d DLQStat
		if err := rows.Scan(&d.Class, &d.Open, &d.OldestOpenAgeSec); err != nil {
			rows.Close()
			return nil, mapQueryErr(err, "scan dlq stats")
		}
		snap.DLQ = append(snap.DLQ, d)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, mapQueryErr(err, "iterate dlq stats")
	}
	rows.Close()

	rows, err = s.pool.Query(ctx,
		`SELECT COALESCE(classification, 'UNCLASSIFIED'), count(*)
		   FROM inbound_event GROUP BY 1`)
	if err != nil {
		return nil, mapQueryErr(err, "metrics classification census")
	}
	for rows.Next() {
		var c string
		var n int64
		if err := rows.Scan(&c, &n); err != nil {
			rows.Close()
			return nil, mapQueryErr(err, "scan classification census")
		}
		snap.Classified[c] = n
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, mapQueryErr(err, "iterate classification census")
	}
	rows.Close()

	rows, err = s.pool.Query(ctx,
		`SELECT COALESCE(from_state,''), COALESCE(to_state,''), reason_code, count(*)
		   FROM audit_event WHERE kind = 'TRANSITION' GROUP BY 1, 2, 3`)
	if err != nil {
		return nil, mapQueryErr(err, "metrics transitions census")
	}
	for rows.Next() {
		var t TransitionCount
		if err := rows.Scan(&t.FromState, &t.ToState, &t.ReasonCode, &t.Count); err != nil {
			rows.Close()
			return nil, mapQueryErr(err, "scan transitions census")
		}
		snap.Transitions = append(snap.Transitions, t)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, mapQueryErr(err, "iterate transitions census")
	}
	rows.Close()

	err = s.pool.QueryRow(ctx,
		`SELECT count(*) FROM step
		  WHERE lease_expires_at IS NOT NULL AND lease_expires_at > now()`).Scan(&snap.LeasesHeld)
	if err != nil {
		return nil, mapQueryErr(err, "metrics leases held")
	}

	return snap, nil
}
