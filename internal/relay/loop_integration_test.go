//go:build integration

package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Lakhyajit-96/fathom/internal/engine"
	"github.com/Lakhyajit-96/fathom/internal/id"
	postgres "github.com/Lakhyajit-96/fathom/internal/store/postgres"
)

// Relay-loop T-INT tests (brief §9 items 9–11, checklist D6 R-T1/R-T2/R-T4):
// real relay loop(s) against real PostgreSQL with a deterministic scripted
// publisher. No Kafka: the Publisher seam is exactly the opt-in boundary
// ADR-006 demands.

var store *postgres.Store

func TestMain(m *testing.M) {
	dsn := os.Getenv("FATHOM_TEST_DATABASE_URL")
	if dsn == "" {
		fmt.Println("integration: FATHOM_TEST_DATABASE_URL unset — skipping relay loop tests")
		os.Exit(0)
	}
	ctx := context.Background()
	st, err := postgres.Open(ctx, dsn)
	if err != nil {
		fmt.Println("integration: open:", err)
		os.Exit(1)
	}
	if err := st.Migrate(ctx); err != nil {
		fmt.Println("integration: migrate:", err)
		os.Exit(1)
	}
	store = st
	code := m.Run()
	store.Close()
	os.Exit(code)
}

func resetDB(t *testing.T) {
	t.Helper()
	_, err := store.Pool().Exec(context.Background(),
		`TRUNCATE attempt, step, processed_events, inbound_event, outbox, api_idempotency, dead_letter, audit_event, workflow,
		         operator_action, relay_checkpoint, workflow_definition CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// seedWorkflows creates n workflows; each W1 create emits exactly one command
// outbox row (a Phase-5 store test finding), so n creates = n deliverable rows.
func seedWorkflows(t *testing.T, n int) []int64 {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < n; i++ {
		_, err := store.CreateWorkflow(ctx, postgres.CreateParams{
			IdempotencyKey: id.New(),
			DefName:        "relay-test", DefVersion: 1,
			DefSnapshot: json.RawMessage(`{"note":"relay loop test"}`),
			BusinessKey: "bk:" + id.New(),
			Input:       json.RawMessage(`{"n":1}`),
			Deadline:    time.Now().UTC().Add(time.Hour),
			Steps:       []engine.StepSpec{{Type: "task-a", MaxAttempts: 1}},
		})
		if err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	rows, err := store.Pool().Query(ctx, `SELECT seq FROM outbox ORDER BY seq`)
	if err != nil {
		t.Fatalf("read seqs: %v", err)
	}
	defer rows.Close()
	var seqs []int64
	for rows.Next() {
		var s int64
		if err := rows.Scan(&s); err != nil {
			t.Fatalf("scan seq: %v", err)
		}
		seqs = append(seqs, s)
	}
	return seqs
}

// scripted is a deterministic publisher: outcomes are functions of the call
// index / rows, never of wall-clock luck.
type scripted struct {
	mu   sync.Mutex
	seen []postgres.RelayRow
	fn   func(rows []postgres.RelayRow) error
}

func (p *scripted) Publish(_ context.Context, rows []postgres.RelayRow) error {
	p.mu.Lock()
	p.seen = append(p.seen, rows...)
	p.mu.Unlock()
	if p.fn != nil {
		return p.fn(rows)
	}
	return nil
}

func (p *scripted) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.seen)
}

func (p *scripted) eventIDs() map[string]int {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := map[string]int{}
	for _, r := range p.seen {
		out[r.EventID]++
	}
	return out
}

func drainIdle(r *Relay, maxPasses int) error {
	ctx := context.Background()
	for i := 0; i < maxPasses; i++ {
		idle, err := r.DrainOnce(ctx)
		if err != nil {
			return err
		}
		if idle {
			return nil
		}
	}
	return fmt.Errorf("relay did not reach idle after %d passes", maxPasses)
}

func drainUntilIdle(t *testing.T, r *Relay, maxPasses int) {
	t.Helper()
	if err := drainIdle(r, maxPasses); err != nil {
		t.Fatalf("drain: %v", err)
	}
}

func nPublished() int {
	var n int
	_ = store.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM outbox WHERE published_at IS NOT NULL`).Scan(&n)
	return n
}

func countRows(t *testing.T, q string, args ...any) int {
	t.Helper()
	var n int
	if err := store.Pool().QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// RL-T01: the happy path — every outbox row is claimed, published, acked in
// one pass per batch; the checkpoint lands at the highest seq; the publisher
// saw each event exactly once.
func TestRelayLoop_AllDelivered(t *testing.T) {
	resetDB(t)
	seqs := seedWorkflows(t, 5)
	pub := &scripted{}
	r, err := New(store, pub, Config{ID: "rl-main", Batch: 2}, nil)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	drainUntilIdle(t, r, 10)

	if got := countRows(t, `SELECT count(*) FROM outbox WHERE published_at IS NOT NULL`); got != len(seqs) {
		t.Fatalf("published = %d, want %d", got, len(seqs))
	}
	if pub.count() != len(seqs) {
		t.Fatalf("publisher saw %d rows, want %d (no duplicates on a healthy relay)", pub.count(), len(seqs))
	}
	cp, err := store.GetRelayCheckpoint(context.Background(), "rl-main")
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	var maxSeq int64
	for _, s := range seqs {
		if s > maxSeq {
			maxSeq = s
		}
	}
	if cp != maxSeq {
		t.Fatalf("checkpoint = %d, want %d", cp, maxSeq)
	}
	if n := r.Published.Load(); n != int64(len(seqs)) {
		t.Fatalf("Published counter = %d, want %d (metrics must reflect real acks)", n, len(seqs))
	}
}

// RL-T02 (brief §9.9): relay crashes AFTER publication but BEFORE ack. The
// row must be redelivered by the next instance — a duplicate publication,
// zero loss — which is exactly the documented at-least-once window.
func TestRelayLoop_CrashAfterPublishBeforeAck(t *testing.T) {
	resetDB(t)
	seqs := seedWorkflows(t, 3)

	ctx, crash := context.WithCancel(context.Background())
	defer crash()
	pub := &scripted{}
	pub.fn = func([]postgres.RelayRow) error {
		crash() // the publisher delivered, then the process died before ack
		return nil
	}
	a, err := New(store, pub, Config{ID: "crashed", LeaseTTL: time.Second}, nil)
	if err != nil {
		t.Fatalf("new A: %v", err)
	}
	if _, err := a.DrainOnce(ctx); err != nil { // claim ok, publish ok, ack sees cancelled ctx
		t.Fatalf("drain A: %v", err)
	}
	// Nothing acked: rows stay unpublished, leases held until expiry.
	if n := countRows(t, `SELECT count(*) FROM outbox WHERE published_at IS NOT NULL`); n != 0 {
		t.Fatalf("crashed relay acked %d rows; ack must fail on dead ctx", n)
	}

	// Lease expiry (1s) hands the rows to a fresh relay: redelivery happens.
	time.Sleep(1200 * time.Millisecond)
	b, err := New(store, pub, Config{ID: "successor"}, nil)
	if err != nil {
		t.Fatalf("new B: %v", err)
	}
	drainUntilIdle(t, b, 10)

	if n := countRows(t, `SELECT count(*) FROM outbox WHERE published_at IS NOT NULL`); n != len(seqs) {
		t.Fatalf("published = %d, want %d: no event may be lost", n, len(seqs))
	}
	if pub.count() < 2*len(seqs) {
		t.Fatalf("publisher saw %d rows; the crash window must produce redelivery, not silence", pub.count())
	}
	for eventID, times := range pub.eventIDs() {
		if times < 2 {
			t.Fatalf("event %s delivered %d times: crash-before-ack must redeliver", eventID, times)
		}
	}
	if cp, _ := store.GetRelayCheckpoint(context.Background(), "crashed"); cp != 0 {
		t.Fatalf("dead relay advanced a checkpoint (%d) without ever acking", cp)
	}
}

// RL-T03 (brief §9.10): two relay instances race over one row. The slow
// owner's lease expires, the new owner publishes and acks, and the stale
// owner's later ack affects zero rows — it can never mark another owner's
// delivery. Both publications exist (at-least-once); one ack exists.
func TestRelayLoop_StaleOwnerCannotAck(t *testing.T) {
	resetDB(t)
	seedWorkflows(t, 1)

	ctx := context.Background()
	pubA := &scripted{}
	pubA.fn = func([]postgres.RelayRow) error {
		// Hold A's publish until B's ack is visible in the database: A's ack
		// then necessarily arrives after ownership moved on — the exact stale
		// shape under test, produced by real claim expiry, not by a mock.
		deadline := time.Now().Add(10 * time.Second)
		for nPublished() == 0 {
			if time.Now().After(deadline) {
				return errors.New("B never acked; A cannot be proven stale")
			}
			time.Sleep(20 * time.Millisecond)
		}
		return nil
	}
	a, err := New(store, pubA, Config{ID: "slow", LeaseTTL: 600 * time.Millisecond}, nil)
	if err != nil {
		t.Fatalf("new A: %v", err)
	}
	aDone := make(chan error, 1)
	go func() { _, err := a.DrainOnce(ctx); aDone <- err }()

	// Wait for A's claim, then let its lease expire before B starts.
	deadline := time.Now().Add(3 * time.Second)
	for countRows(t, `SELECT count(*) FROM outbox WHERE claimed_by='slow'`) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("A never claimed the row")
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(700 * time.Millisecond) // lease expiry — the row becomes takeable

	pubB := &scripted{}
	b, err := New(store, pubB, Config{ID: "taker"}, nil)
	if err != nil {
		t.Fatalf("new B: %v", err)
	}
	drainUntilIdle(t, b, 10) // B re-claims, publishes, acks — one real delivery

	if err := <-aDone; err != nil {
		t.Fatalf("drain A: %v", err)
	}
	if n := a.Redeliveries.Load(); n != 1 {
		t.Fatalf("stale relay acked %d rows; a dead lease must ack zero", n)
	}
	if n := a.Published.Load(); n != 0 {
		t.Fatalf("stale relay counted %d publications under its own ack", n)
	}
	if n := b.Published.Load(); n != 1 {
		t.Fatalf("new owner acked %d, want 1", n)
	}
	if n := countRows(t, `SELECT count(*) FROM outbox WHERE published_at IS NOT NULL`); n != 1 {
		t.Fatalf("published rows = %d, want 1", n)
	}
	// Two deliveries (at-least-once, honest), one durable ack (ownership-safe).
	if pubA.count() != 1 || pubB.count() != 1 {
		t.Fatalf("publisher sightings A=%d B=%d, want 1+1 (duplicate delivery is the documented cost, double-ack is not)", pubA.count(), pubB.count())
	}
}

// RL-T04: transient publish failure backs off per row (durable retry state),
// then the retry succeeds — bounded, visible, no dead-letter.
func TestRelayLoop_TransientFailureThenSuccess(t *testing.T) {
	resetDB(t)
	seedWorkflows(t, 1)
	var fail bool = true
	pub := &scripted{}
	pub.fn = func([]postgres.RelayRow) error {
		if fail {
			return errors.New("broker unavailable")
		}
		return nil
	}
	r, err := New(store, pub, Config{ID: "rt4"}, nil)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	drainUntilIdle(t, r, 5) // first pass fails, second finds the row backed off => idle
	if n := countRows(t, `SELECT count(*) FROM outbox WHERE retry_count=1 AND published_at IS NULL AND next_retry_at > now()`); n != 1 {
		t.Fatalf("row not backed off with durable retry state (retry_count=1, future next_retry_at)")
	}
	if n := countRows(t, `SELECT count(*) FROM dead_letter`); n != 0 {
		t.Fatalf("transient failure must not dead-letter, got %d", n)
	}
	// Age the backoff away (clock control via DB, not sleeps), then succeed.
	if _, err := store.Pool().Exec(context.Background(),
		`UPDATE outbox SET next_retry_at = now() - interval '1 second' WHERE next_retry_at IS NOT NULL`); err != nil {
		t.Fatalf("age backoff: %v", err)
	}
	fail = false
	drainUntilIdle(t, r, 5)
	if n := countRows(t, `SELECT count(*) FROM outbox WHERE published_at IS NOT NULL`); n != 1 {
		t.Fatal("retry must deliver after backoff")
	}
	if pub.count() != 2 {
		t.Fatalf("publisher sightings = %d, want 2 (one failure, one success)", pub.count())
	}
}

// RL-T05 (checklist R-T4): a permanently failing delivery exhausts the
// bounded budget and files RETRY_EXHAUSTED dead-letter + audit — then the
// row is inert (never claimed again).
func TestRelayLoop_ExhaustionDeadLetters(t *testing.T) {
	resetDB(t)
	seedWorkflows(t, 1)
	pub := &scripted{}
	pub.fn = func([]postgres.RelayRow) error { return errors.New("topic forbidden") }
	r, err := New(store, pub, Config{ID: "rt5", MaxRetries: 2}, nil)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := r.DrainOnce(context.Background()); err != nil {
			t.Fatalf("drain %d: %v", i, err)
		}
		// age backoff between attempts (clock control, not real 2s/4s waits)
		if _, err := store.Pool().Exec(context.Background(),
			`UPDATE outbox SET next_retry_at = now() - interval '1 second' WHERE next_retry_at IS NOT NULL`); err != nil {
			t.Fatalf("age: %v", err)
		}
	}
	if n := countRows(t, `SELECT count(*) FROM outbox WHERE failed_at IS NOT NULL`); n != 1 {
		t.Fatal("exhausted row must carry failed_at")
	}
	if n := countRows(t, `SELECT count(*) FROM dead_letter WHERE class='RETRY_EXHAUSTED' AND reason_code='RELAY_DELIVERY_EXHAUSTED'`); n != 1 {
		t.Fatalf("RETRY_EXHAUSTED dead_letter rows = %d, want 1", n)
	}
	if n := countRows(t, `SELECT count(*) FROM audit_event WHERE kind='DEADLETTER'`); n != 1 {
		t.Fatal("dead-letter filing must be audited")
	}
	if n := r.Exhausted.Load(); n != 1 {
		t.Fatalf("Exhausted counter = %d, want 1", n)
	}
	// Inert: no further claims, no re-death.
	drainUntilIdle(t, r, 5)
	if pub.count() != 2 {
		t.Fatalf("exhausted row was re-published: sightings = %d, want 2", pub.count())
	}
}

// RL-T06: a broker that answers per record gets per-row accounting — the
// accepted rows are acked, only the rejected row backs off. (The franz-go
// publisher reports exactly this shape via *Partial.)
func TestRelayLoop_PartialFailure(t *testing.T) {
	resetDB(t)
	seqs := seedWorkflows(t, 3)
	bad := seqs[1]
	pub := &scripted{}
	pub.fn = func([]postgres.RelayRow) error {
		return &Partial{Failed: map[int64]error{bad: errors.New("not leader for partition")}, Err: errors.New("one record rejected")}
	}
	r, err := New(store, pub, Config{ID: "rt6", MaxRetries: 5}, nil)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	if _, err := r.DrainOnce(context.Background()); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if n := countRows(t, `SELECT count(*) FROM outbox WHERE published_at IS NOT NULL`); n != 2 {
		t.Fatalf("acked = %d, want 2 (the broker-accepted rows)", n)
	}
	if n := countRows(t, `SELECT count(*) FROM outbox WHERE seq=$1 AND retry_count=1 AND published_at IS NULL`, bad); n != 1 {
		t.Fatal("only the rejected row may carry the failed attempt")
	}
	if n := r.Published.Load(); n != 2 {
		t.Fatalf("Published = %d, want 2", n)
	}
}

// RL-T07: four concurrent relay instances drain eight rows with small
// batches — claims are disjoint and every row is acked by exactly ONE owner
// (sum of ack counters == rows; double-acks are structurally impossible but
// the counters prove it rather than assume it).
func TestRelayLoop_ConcurrentRelaysAckExactlyOnce(t *testing.T) {
	resetDB(t)
	seqs := seedWorkflows(t, 8)
	var wg sync.WaitGroup
	var errs []chan error
	pubs := make([]*scripted, 4)
	relays := make([]*Relay, 4)
	for i := 0; i < 4; i++ {
		pubs[i] = &scripted{}
		r, err := New(store, pubs[i], Config{ID: fmt.Sprintf("rt7-%d", i), Batch: 2, LeaseTTL: 5 * time.Second}, nil)
		if err != nil {
			t.Fatalf("new %d: %v", i, err)
		}
		relays[i] = r
		errCh := make(chan error, 1)
		errs = append(errs, errCh)
		wg.Add(1)
		go func(r *Relay, ch chan error) {
			defer wg.Done()
			ch <- drainIdle(r, 20)
		}(r, errCh)
	}
	wg.Wait()
	for _, ch := range errs {
		if err := <-ch; err != nil {
			t.Fatalf("concurrent drain: %v", err)
		}
	}

	var total int64
	for _, r := range relays {
		total += r.Published.Load()
	}
	if total != int64(len(seqs)) {
		t.Fatalf("sum of relay acks = %d, want %d (each row exactly one owner)", total, len(seqs))
	}
	if n := countRows(t, `SELECT count(*) FROM outbox WHERE published_at IS NOT NULL`); n != len(seqs) {
		t.Fatalf("published = %d, want %d", n, len(seqs))
	}
}
