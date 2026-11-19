// Package kafka is the OPTIONAL franz-go Publisher for the outbox relay
// (ADR-005/006, brief §7). Nothing in the default engine imports or requires
// it: no CGO, no cluster. It exists for the deployment shape where commands
// must reach a real broker, and it honours the ADR-007 measured routing
// contract — record key = aggregate_id (= workflow_id, the ADR-010 partition
// key), headers carry the stable event identity so consumers and the CDC
// lane see the same fields.
//
// Durability choices, from the Phase-3 live measurements (ADR-005), not from
// package names: producers are IDEMPOTENT by default (franz-go opts OUT via
// DisableIdempotentWrite — we do not opt out), and acks are set explicitly
// to all-ISR so the assumption is visible in code. Transactional/EOS
// producing is deliberately NOT used: the design is at-least-once outbox +
// consumer dedup (ADR-011), and a duplicate publication from the relay's
// crash window must not be silently "fixed" at the transport.
package kafka

import (
	"context"
	"errors"
	"fmt"

	"github.com/twmb/franz-go/pkg/kgo"

	"github.com/lakhyach/fathom/internal/relay"
	postgres "github.com/lakhyach/fathom/internal/store/postgres"
)

// Config names the brokers. Empty Brokers is a construction error — the
// caller decides whether Kafka runs at all (relay stays broker-less otherwise).
type Config struct {
	Brokers []string
	// AdditionalOpts are appended last, so a deployment can add TLS/SASL
	// without this package pretending to own those decisions.
	AdditionalOpts []kgo.Opt
}

// Publisher implements relay.Publisher against a Kafka cluster.
type Publisher struct {
	cli *kgo.Client
}

var _ relay.Publisher = (*Publisher)(nil)

// New connects (lazily — franz-go dials on first use) and validates opts.
func New(cfg Config) (*Publisher, error) {
	if len(cfg.Brokers) == 0 {
		return nil, errors.New("kafka publisher: brokers required (relay without Kafka is the default; do not start this publisher with none)")
	}
	opts := []kgo.Opt{
		kgo.SeedBrokers(cfg.Brokers...),
		kgo.RequiredAcks(kgo.AllISRAcks()), // measured surface (ADR-005)
		// Idempotence is franz-go's default and we keep it: retried
		// productions dedupe at the broker, so OUR at-least-once relay does
		// not add broker-level duplicates on top.
	}
	opts = append(opts, cfg.AdditionalOpts...)
	cli, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, fmt.Errorf("kafka publisher: %w", err)
	}
	return &Publisher{cli: cli}, nil
}

// Publish produces the whole batch with one synchronous round-trip set and
// reports per-row results through relay.Partial: the loop acks exactly the
// records the broker accepted (all-ISR), never a "batch call returned"
// illusion.
func (p *Publisher) Publish(ctx context.Context, rows []postgres.RelayRow) error {
	recs := make([]*kgo.Record, 0, len(rows))
	byRecord := make(map[*kgo.Record]int64, len(rows))
	for _, row := range rows {
		rec := &kgo.Record{
			Topic: row.Topic,
			Key:   []byte(row.AggregateID), // = workflow_id: per-workflow partition ordering (ADR-010)
			Value: row.Payload,
			Headers: []kgo.RecordHeader{
				{Key: "event_id", Value: []byte(row.EventID)}, // stable identity for dedupe (DATA §D)
				{Key: "workflow_id", Value: []byte(row.WorkflowID)},
			},
		}
		recs = append(recs, rec)
		byRecord[rec] = row.Seq
	}

	results := p.cli.ProduceSync(ctx, recs...)
	var failed map[int64]error
	var agg error
	for _, res := range results {
		if res.Err == nil {
			continue
		}
		if failed == nil {
			failed = make(map[int64]error)
		}
		failed[byRecord[res.Record]] = res.Err
		if agg == nil {
			agg = res.Err
		}
	}
	if failed != nil {
		return &relay.Partial{Failed: failed, Err: agg}
	}
	return nil
}

// Close flushes in-flight produces and releases the client.
func (p *Publisher) Close() error {
	p.cli.Close()
	return nil
}
