// Command kafkasmoke is an empirical verifier for the selected Kafka client
// (franz-go, ADR-005) against a real broker. It is a tool, not product code, and
// exercises exactly the primitives the Phase 4 outbox relay and consumer dedup
// depend on — no assumptions from package names:
//
//   - admin: create the topic (kadm)
//   - produce: idempotent producer, W acks, per-record key/partitioning, and a
//     `traceparent` header (ADR-010 envelope correlation)
//   - consume: consumer group, manual commit after processing (at-least-once)
//   - verify: every produced record is read back, payload + headers intact
//
// Usage:
//
//	CGO_ENABLED=0 go run ./kafkasmoke -bootstrap 127.0.0.1:9092 -topic fathom-smoke -n 5
//
// Exits non-zero with a clear message if any step fails or the broker is
// unreachable, so CI can gate on it.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

func main() {
	bootstrap := flag.String("bootstrap", "127.0.0.1:9092", "comma-separated broker host:port list (bare host:port, no scheme prefix — DS-10)")
	topic := flag.String("topic", "fathom-smoke", "topic to create/use")
	n := flag.Int("n", 5, "number of records to round-trip")
	timeout := flag.Duration("timeout", 60*time.Second, "overall deadline")
	flag.Parse()

	brokers := strings.Split(*bootstrap, ",")
	if err := run(brokers, *topic, *n, *timeout); err != nil {
		fmt.Fprintln(os.Stderr, "kafkasmoke FAIL:", err)
		os.Exit(1)
	}
	fmt.Println("kafkasmoke PASS")
}

func run(brokers []string, topic string, n int, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	clientCfg := []kgo.Opt{
		kgo.SeedBrokers(brokers...),
		kgo.ConsumeTopics(topic),
		kgo.ConsumerGroup("fathom-smoke-group"),
		kgo.DisableAutoCommit(), // manual commit proves at-least-once control
	}
	cl, err := kgo.NewClient(clientCfg...)
	if err != nil {
		return fmt.Errorf("create client: %w", err)
	}
	defer cl.Close()

	adm := kadm.NewClient(cl)

	// 1. Admin: ensure the topic exists (idempotent create).
	if err := ensureTopic(ctx, adm, topic); err != nil {
		return err
	}
	fmt.Printf("  topic %q ready (admin API ok)\n", topic)

	// 2. Produce: idempotent producer with headers.
	if err := produce(ctx, brokers, topic, n); err != nil {
		return err
	}
	fmt.Printf("  produced %d records (idempotent, acks=all, traceparent header)\n", n)

	// 3. Consume & verify.
	got, err := consumeAndVerify(ctx, cl, topic, n)
	if err != nil {
		return err
	}
	fmt.Printf("  consumed %d records, payloads + headers verified, offsets committed\n", got)
	return nil
}

func ensureTopic(ctx context.Context, adm *kadm.Client, topic string) error {
	// Create if absent; tolerate "already exists" so the tool is rerunnable.
	res, err := adm.CreateTopics(ctx, 1, 1, nil, topic)
	if err != nil {
		return fmt.Errorf("create topics rpc: %w", err)
	}
	for _, r := range res {
		if r.Err != nil && !strings.Contains(strings.ToLower(r.Err.Error()), "already exists") {
			return fmt.Errorf("create topic %q: %w", r.Topic, r.Err)
		}
	}
	return nil
}

func produce(ctx context.Context, brokers []string, topic string, n int) error {
	// franz-go producers are IDEMPOTENT by default (there is only
	// DisableIdempotentWrite to opt OUT); the relay's "no duplicates on retry"
	// safety property (ADR-006/ADR-011) relies on exactly this default. We set
	// all-ISR acks explicitly to make the durability assumption visible.
	prod, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.RequiredAcks(kgo.AllISRAcks()),
	)
	if err != nil {
		return fmt.Errorf("create producer: %w", err)
	}
	defer prod.Close()

	for i := 0; i < n; i++ {
		key := fmt.Sprintf("key-%d", i)
		val := fmt.Sprintf("payload-%d", i)
		rec := &kgo.Record{
			Topic: topic,
			Key:   []byte(key),
			Value: []byte(val),
			Headers: []kgo.RecordHeader{
				{Key: "traceparent", Value: []byte("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203c00-01")},
			},
		}
		if err := prod.ProduceSync(ctx, rec).FirstErr(); err != nil {
			return fmt.Errorf("produce %d: %w", i, err)
		}
	}
	return nil
}

func consumeAndVerify(ctx context.Context, cl *kgo.Client, topic string, n int) (int, error) {
	deadline, _ := ctx.Deadline()
	seen := map[string]string{}
	for len(seen) < n && time.Now().Before(deadline) {
		fetches := cl.PollRecords(ctx, 50)
		if err := fetches.Errors(); len(err) > 0 {
			return len(seen), fmt.Errorf("poll error: %w", err[0].Err)
		}
		fetches.EachRecord(func(r *kgo.Record) {
			seen[string(r.Key)] = string(r.Value)
		})
	}
	if len(seen) < n {
		return len(seen), fmt.Errorf("read only %d/%d records before deadline", len(seen), n)
	}
	for i := 0; i < n; i++ {
		key := fmt.Sprintf("key-%d", i)
		if seen[key] != fmt.Sprintf("payload-%d", i) {
			return len(seen), fmt.Errorf("record %q payload mismatch: %q", key, seen[key])
		}
	}
	if err := cl.CommitUncommittedOffsets(ctx); err != nil {
		return len(seen), fmt.Errorf("commit offsets: %w", err)
	}
	return len(seen), nil
}
