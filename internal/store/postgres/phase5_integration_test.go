//go:build integration

package postgres

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lakhyach/fathom/internal/engine"
	"github.com/lakhyach/fathom/internal/id"
)

// Phase-5 T-INT store tier: worker claiming/leases, the SubmitResult lease
// gate, scheduler scans, deadline stamping, definitions, DLQ/operator actions
// and the relay claim protocol — all against real PostgreSQL (§9 of the brief
// requires real-concurrency proofs; mocks are insufficient). Loop-level
// integration (worker/reaper/relay-publisher) is exercised in the runtime
// suites; this file proves the durable primitives they sit on.

// ---- helpers ---------------------------------------------------------------

// expireStepLease backdates the lease so the database clock sees it expired.
func expireStepLease(t *testing.T, wfID, stepType string) {
	t.Helper()
	_, err := testStore.Pool().Exec(ctxc(),
		`UPDATE step SET lease_expires_at = now() - interval '5 seconds'
		  WHERE workflow_id = $1 AND step_type = $2`, wfID, stepType)
	if err != nil {
		t.Fatalf("expire lease: %v", err)
	}
}

func mustClaim(t *testing.T, workerID string) (Claim, bool) {
	t.Helper()
	c, ok, err := testStore.ClaimStep(ctxc(), workerID, DefaultLeaseTTL)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	return c, ok
}

func queryWFState(t *testing.T, wfID string) (string, int64) {
	t.Helper()
	var st string
	var v int64
	err := testStore.Pool().QueryRow(ctxc(),
		`SELECT state, version FROM workflow WHERE id = $1`, wfID).Scan(&st, &v)
	if err != nil {
		t.Fatalf("wf state: %v", err)
	}
	return st, v
}

func rawEnv() json.RawMessage { return json.RawMessage(`{"data":{"outcome":"x"}}`) }

// ---- §2 claiming + leases ----------------------------------------------------

// W-T01/W-T02: a claim is exclusive while the lease is live; a second worker
// gets nothing; renewal belongs to the holder only.
func TestStore_ClaimMutualExclusionAndRenew(t *testing.T) {
	reset(t)
	wf := seedRunning(t)

	c, ok := mustClaim(t, "w1")
	if !ok || c.WorkflowID != wf.ID || c.StepType != "reserve-room" || c.Attempt != 1 || c.Task != "reserve-room" || c.Compensation {
		t.Fatalf("bad claim %+v", c)
	}
	if _, ok := mustClaim(t, "w2"); ok {
		t.Fatal("second worker must not claim a leased step")
	}
	// The claim flipped ISSUED -> IN_PROGRESS and stamped a DB-clock lease.
	var state string
	var live bool
	err := testStore.Pool().QueryRow(ctxc(),
		`SELECT state, lease_expires_at > now() FROM step WHERE workflow_id = $1 AND step_type = $2`,
		wf.ID, "reserve-room").Scan(&state, &live)
	if err != nil || state != "IN_PROGRESS" || !live {
		t.Fatalf("step after claim: state=%s live=%v err=%v", state, live, err)
	}
	if ok, err := testStore.RenewLease(ctxc(), wf.ID, "reserve-room", "w2", DefaultLeaseTTL); err != nil || ok {
		t.Fatalf("non-holder renew must fail: ok=%v err=%v", ok, err)
	}
	if ok, err := testStore.RenewLease(ctxc(), wf.ID, "reserve-room", "w1", DefaultLeaseTTL); err != nil || !ok {
		t.Fatalf("holder renew: ok=%v err=%v", ok, err)
	}
	// Release hands the step back and it becomes claimable again.
	if ok, err := testStore.ReleaseLease(ctxc(), wf.ID, "reserve-room", "w1"); err != nil || !ok {
		t.Fatalf("release: ok=%v err=%v", ok, err)
	}
	if c2, ok := mustClaim(t, "w2"); !ok || c2.StepType != "reserve-room" || c2.Attempt != 1 {
		t.Fatalf("released step must be re-claimable at the same attempt: %+v ok=%v", c2, ok)
	}
}

// W-T03: expired leases are NOT directly claimable — only the reaper's
// reclaim path may raise the fencing token, then the step is claimable at
// the higher attempt, and the dead holder's late word is refused.
func TestStore_ExpiredLeaseRequiresReclaim(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	if _, ok := mustClaim(t, "w1"); !ok {
		t.Fatal("claim failed")
	}
	expireStepLease(t, wf.ID, "reserve-room")

	if _, ok := mustClaim(t, "w2"); ok {
		t.Fatal("expired-lease step must not be claimable before reclaim")
	}
	// Reaper sees it as a lease-loss candidate.
	overdue, err := testStore.ScanOverdueSteps(ctxc(), 10)
	if err != nil {
		t.Fatalf("scan overdue: %v", err)
	}
	if len(overdue) != 1 || overdue[0].Kind != OverdueLease || overdue[0].StepType != "reserve-room" {
		t.Fatalf("overdue scan = %+v, want one LEASE_EXPIRED reserve-room", overdue)
	}
	out, err := testStore.ReclaimLease(ctxc(), wf.ID, "reserve-room", overdue[0].Version)
	if err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	if out.Version != wf.Version+1 {
		t.Fatalf("version after reclaim = %d, want %d", out.Version, wf.Version+1)
	}
	// Attempt 1 settled LOST, attempt 2 opened ISSUED with a re-issue command.
	if n := count(t, `SELECT count(*) FROM attempt WHERE workflow_id=$1 AND step_type='reserve-room' AND number=1 AND state='LOST'`, wf.ID); n != 1 {
		t.Fatal("lost attempt not settled")
	}
	if n := count(t, `SELECT count(*) FROM attempt WHERE workflow_id=$1 AND step_type='reserve-room' AND number=2 AND state='ISSUED'`, wf.ID); n != 1 {
		t.Fatal("re-issue did not open attempt 2")
	}
	if n := count(t, `SELECT count(*) FROM audit_event WHERE workflow_id=$1 AND reason_code='LEASE_RECLAIMED'`, wf.ID); n != 1 {
		t.Fatal("LEASE_RECLAIMED audit missing")
	}
	// Lease cleared by syncSteps: now w2 can claim at attempt 2.
	c, ok := mustClaim(t, "w2")
	if !ok || c.Attempt != 2 {
		t.Fatalf("post-reclaim claim = %+v ok=%v, want attempt 2", c, ok)
	}
	// The dead holder's late result must not apply (fencing via lease gate).
	if cl, err := testStore.SubmitResult(ctxc(), successEvent(wf.ID, "reserve-room", 2, out.Version), rawEnv(), "w1"); err != nil || cl != engine.ClassStale {
		t.Fatalf("displaced submit: class=%s err=%v, want STALE", cl, err)
	}
	if n := count(t, `SELECT count(*) FROM audit_event WHERE workflow_id=$1 AND reason_code='RESULT_STALE_LEASE'`, wf.ID); n != 1 {
		t.Fatal("stale-lease rejection not audited")
	}
	st, _ := queryWFState(t, wf.ID)
	if st != string(engine.StateRunning) {
		t.Fatalf("state changed by stale submit: %s", st)
	}
	// The rightful holder applies normally.
	if cl, err := testStore.SubmitResult(ctxc(), successEvent(wf.ID, "reserve-room", 2, out.Version), rawEnv(), "w2"); err != nil || cl != engine.ClassApplied {
		t.Fatalf("holder submit: class=%s err=%v, want APPLIED", cl, err)
	}
}

// W-T04: reclaim at the attempt budget takes the W7/W8 fork, never a fourth
// attempt: the step settles TIMED_OUT, the workflow terminates per the
// compensation rules, and nothing further is claimable.
func TestStore_ReclaimAtBudgetTerminates(t *testing.T) {
	reset(t)
	p := twoStepParams()
	p.Steps[0].MaxAttempts = 1
	p.Steps[1].MaxAttempts = 1
	out, err := testStore.CreateWorkflow(ctxc(), p)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wf, err := testStore.Start(ctxc(), out.Workflow.ID, out.Workflow.Version)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, ok := mustClaim(t, "w1"); !ok {
		t.Fatal("claim failed")
	}
	expireStepLease(t, wf.ID, "reserve-room")
	res, err := testStore.ReclaimLease(ctxc(), wf.ID, "reserve-room", wf.Version)
	if err != nil {
		t.Fatalf("reclaim at budget: %v", err)
	}
	// No completed compensable steps: W8 straight to FAILED.
	if res.State != engine.StateFailed {
		t.Fatalf("state = %s, want FAILED", res.State)
	}
	if n := count(t, `SELECT count(*) FROM attempt WHERE workflow_id=$1 AND number=1 AND state='LOST'`, wf.ID); n != 1 {
		t.Fatal("last attempt must still be settled LOST")
	}
	if _, ok := mustClaim(t, "w2"); ok {
		t.Fatal("nothing claimable under a terminal workflow")
	}
}

// W-T05 (concurrent): N workers racing one step — exactly one claims.
func TestStore_ClaimRaceSingleWinner(t *testing.T) {
	reset(t)
	seedRunning(t)
	const racers = 8
	var won int32
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, ok, err := testStore.ClaimStep(ctxc(), fmt.Sprintf("racer-%d", i), DefaultLeaseTTL); err != nil {
				t.Errorf("racer claim: %v", err)
				return
			} else if ok {
				atomic.AddInt32(&won, 1)
			}
		}(i)
	}
	wg.Wait()
	if won != 1 {
		t.Fatalf("claim winners = %d, want exactly 1", won)
	}
}

// ---- §4 retry/timeout scheduler inputs --------------------------------------

// S-T01: queue scan drives W2; due-retry scan drives W6; both only surface
// genuinely due rows and the guarded transition refuses double-drive.
func TestStore_ScansDriveRetryAndStart(t *testing.T) {
	reset(t)
	out, err := testStore.CreateWorkflow(ctxc(), twoStepParams())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	q, err := testStore.ScanQueued(ctxc(), 10)
	if err != nil || len(q) != 1 || q[0].ID != out.Workflow.ID {
		t.Fatalf("queued scan = %+v err=%v", q, err)
	}
	if _, err := testStore.Start(ctxc(), q[0].ID, q[0].Version); err != nil {
		t.Fatalf("start: %v", err)
	}
	// A retryable failure parks the workflow with a DURABLE due time.
	wf := loadState(t, out.Workflow.ID)
	apply(t, failEvent(wf.ID, "reserve-room", 1, engine.ErrRetryable, wf.Version))
	wf = loadState(t, out.Workflow.ID)
	if wf.State != engine.StateRetryWaiting {
		t.Fatalf("after retryable fail: state=%s", wf.State)
	}
	// The retry schedule is DURABLE: next_attempt_at set on the row (DB clock).
	var dueAt bool
	if err := testStore.Pool().QueryRow(ctxc(),
		`SELECT next_attempt_at IS NOT NULL FROM workflow WHERE id = $1`, wf.ID).Scan(&dueAt); err != nil || !dueAt {
		t.Fatalf("next_attempt_at not persisted: err=%v", err)
	}
	// Not due yet (backoff in the future): the scan must not list it.
	if due, err := testStore.ScanDueRetries(ctxc(), 10); err != nil || len(due) != 0 {
		t.Fatalf("premature due-retry scan: %+v err=%v", due, err)
	}
	if _, err := testStore.Pool().Exec(ctxc(),
		`UPDATE workflow SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, wf.ID); err != nil {
		t.Fatalf("age next_attempt: %v", err)
	}
	due, err := testStore.ScanDueRetries(ctxc(), 10)
	if err != nil || len(due) != 1 || due[0].ID != wf.ID {
		t.Fatalf("due-retry scan = %+v err=%v", due, err)
	}
	if _, err := testStore.Retry(ctxc(), due[0].ID, due[0].Version); err != nil {
		t.Fatalf("retry: %v", err)
	}
	// Double-drive: the second Retry hits the version guard, not a silent rewrite.
	if _, err := testStore.Retry(ctxc(), due[0].ID, due[0].Version); err == nil {
		t.Fatal("stale-version retry must conflict")
	} else {
		var ce ConflictError
		if !errors.As(err, &ce) {
			t.Fatalf("want ConflictError, got %v", err)
		}
	}
	// W6 re-issue opened attempt 2 — claimable at the new fencing token.
	c, ok := mustClaim(t, "w1")
	if !ok || c.Attempt != 2 {
		t.Fatalf("post-retry claim = %+v ok=%v, want attempt 2", c, ok)
	}
}

// S-T02: issuing a step stamps response_deadline_at from the step's declared
// forward timeout (DB clock); entering compensation stamps the compensation
// deadline; settling clears both (syncSteps is the single writer).
func TestStore_DeadlineStamping(t *testing.T) {
	reset(t)
	p := twoStepParams()
	p.Steps[0].ForwardTimeout = 120 * time.Second
	p.Steps[0].CompensatorTask = "release-room"
	oc, err := testStore.CreateWorkflow(ctxc(), p)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Fresh PENDING steps carry no deadlines.
	if n := count(t, `SELECT count(*) FROM step WHERE workflow_id=$1 AND response_deadline_at IS NOT NULL`, oc.Workflow.ID); n != 0 {
		t.Fatal("PENDING steps must not carry deadlines")
	}
	wf, err := testStore.Start(ctxc(), oc.Workflow.ID, oc.Workflow.Version)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	var age float64
	err = testStore.Pool().QueryRow(ctxc(),
		`SELECT EXTRACT(EPOCH FROM (response_deadline_at - now())) FROM step WHERE workflow_id=$1 AND step_type='reserve-room'`,
		wf.ID).Scan(&age)
	if err != nil || age < 115 || age > 121 {
		t.Fatalf("forward deadline age = %v err=%v, want ~120s of DB clock", age, err)
	}
	// Step 1 succeeds (settles; deadlines cleared), terminal step-2 failure
	// enters compensation: step 1's compensation_deadline_at is stamped.
	apply(t, successEvent(wf.ID, "reserve-room", 1, wf.Version))
	wf = loadState(t, oc.Workflow.ID)
	apply(t, failEvent(wf.ID, "charge-payment", 1, engine.ErrTerminal, wf.Version))
	var cage float64
	err = testStore.Pool().QueryRow(ctxc(),
		`SELECT EXTRACT(EPOCH FROM (compensation_deadline_at - now())) FROM step WHERE workflow_id=$1 AND step_type='reserve-room'`,
		oc.Workflow.ID).Scan(&cage)
	if err != nil {
		t.Fatalf("comp deadline: %v", err)
	}
	if cage < 55 || cage > 61 {
		t.Fatalf("compensation deadline = %vs, want ~60s default", cage)
	}
	// The compensation command targets the declared compensator task.
	if n := count(t, `SELECT count(*) FROM outbox WHERE workflow_id=$1 AND step_type='reserve-room'
	    AND payload->>'step_type'='reserve-room' AND (payload->'data'->>'compensation')='true'`, oc.Workflow.ID); n != 1 {
		t.Fatal("compensation command missing")
	}
	if n := count(t, `SELECT count(*) FROM step WHERE workflow_id=$1 AND step_type='reserve-room' AND response_deadline_at IS NOT NULL`, oc.Workflow.ID); n != 0 {
		t.Fatal("settled step must have cleared its forward deadline")
	}
}

// S-T03: deadline scan + W13 escalation through the store (direct arm: no
// completed compensable work) lands FAILED_MANUAL with a DEADLINE DLQ item.
func TestStore_DeadlineEscalation(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	if _, err := testStore.Pool().Exec(ctxc(),
		`UPDATE workflow SET deadline_at = now() - interval '1 second' WHERE id = $1`, wf.ID); err != nil {
		t.Fatalf("age deadline: %v", err)
	}
	cands, err := testStore.ScanExpiredDeadlines(ctxc(), 10)
	if err != nil || len(cands) != 1 || cands[0].ID != wf.ID {
		t.Fatalf("deadline scan = %+v err=%v", cands, err)
	}
	res, err := testStore.EscalateDeadline(ctxc(), cands[0].ID, cands[0].Version)
	if err != nil {
		t.Fatalf("escalate: %v", err)
	}
	if res.State != engine.StateFailedManual {
		t.Fatalf("state = %s, want FAILED_MANUAL", res.State)
	}
	if n := count(t, `SELECT count(*) FROM dead_letter WHERE workflow_id=$1 AND class='DEADLINE'`, wf.ID); n != 1 {
		t.Fatal("DEADLINE dead letter missing")
	}
	// FAILED_MANUAL is inert: re-escalation is refused, and the row is not
	// double-bumped.
	if _, err := testStore.EscalateDeadline(ctxc(), wf.ID, res.Version); err == nil {
		t.Fatal("re-escalation of FAILED_MANUAL must be refused")
	}
	if _, st := queryWFState(t, wf.ID); st != res.Version {
		t.Fatalf("version moved on refused escalation: %d vs %d", st, res.Version)
	}
}

// ---- §5 operator actions + DLQ (M-T items) ----------------------------------

// M-T01: operator cancel records the authorization row and attributes the
// audit; an internal cancel (no operator) records neither.
func TestStore_OperatorCancelRecordsAction(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	plain, err := testStore.Cancel(ctxc(), wf.ID, wf.Version, Operator{})
	if err != nil {
		t.Fatalf("internal cancel: %v", err)
	}
	if n := count(t, `SELECT count(*) FROM operator_action WHERE workflow_id=$1`, wf.ID); n != 0 {
		t.Fatal("internal cancel must not record an operator_action")
	}
	// CANCELLING from W14; cancel again as an operator on the new version.
	_, err = testStore.Cancel(ctxc(), plain.ID, plain.Version,
		Operator{Actor: "ops-key", Role: "operator", Reason: "customer request"})
	// Second cancel of CANCELLING must be refused by the machine (no edge),
	// and refusals record nothing.
	if err == nil {
		t.Fatal("double cancel must be refused")
	}
	if n := count(t, `SELECT count(*) FROM operator_action WHERE workflow_id=$1`, wf.ID); n != 0 {
		t.Fatal("refused action recorded an operator_action")
	}
}

// M-T02: retry-now (W18) by an operator bypasses remaining backoff, bumps the
// attempt, re-issues, and is fully attributed (audit detail + operator_action).
func TestStore_RetryNowOperator(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	apply(t, failEvent(wf.ID, "reserve-room", 1, engine.ErrRetryable, wf.Version))
	wf = loadState(t, wf.ID)
	if wf.State != engine.StateRetryWaiting {
		t.Fatalf("want RETRY_WAITING, got %s", wf.State)
	}
	res, err := testStore.RetryNow(ctxc(), wf.ID, wf.Version,
		Operator{Actor: "ops-1", Role: "operator", Reason: "participant recovered"})
	if err != nil {
		t.Fatalf("retry-now: %v", err)
	}
	if res.State != engine.StateRunning {
		t.Fatalf("after retry-now: %s", res.State)
	}
	if n := count(t, `SELECT count(*) FROM operator_action WHERE workflow_id=$1 AND action='retry-now' AND actor='ops-1'`, wf.ID); n != 1 {
		t.Fatal("retry-now operator_action missing")
	}
	if n := count(t, `SELECT count(*) FROM audit_event WHERE workflow_id=$1 AND kind='OPERATOR_ACTION' AND detail->>'actor'='ops-1'`, wf.ID); n != 1 {
		t.Fatal("operator audit attribution missing")
	}
	// Durable schedule cleared when leaving RETRY_WAITING.
	if n := count(t, `SELECT count(*) FROM workflow WHERE id=$1 AND next_attempt_at IS NULL`, wf.ID); n != 1 {
		t.Fatal("next_attempt_at must be cleared")
	}
	c, ok := mustClaim(t, "w1")
	if !ok || c.Attempt != 2 {
		t.Fatalf("retry-now claim = %+v ok=%v", c, ok)
	}
}

// M-T03: the full W17 contract — dry-run previews without touching state;
// force-terminate closes the workflow AND resolves the DLQ item atomically;
// re-resolution is a typed refusal; complete-compensation marks outstanding
// compensable steps COMPENSATED and ABORTs.
func TestStore_ResolveDeadLetter(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	if _, err := testStore.Pool().Exec(ctxc(),
		`UPDATE workflow SET deadline_at = now() - interval '1 second' WHERE id = $1`, wf.ID); err != nil {
		t.Fatalf("age deadline: %v", err)
	}
	if _, err := testStore.EscalateDeadline(ctxc(), wf.ID, wf.Version); err != nil {
		t.Fatalf("escalate: %v", err)
	}
	var dlID string
	err := testStore.Pool().QueryRow(ctxc(),
		`SELECT id FROM dead_letter WHERE workflow_id = $1`, wf.ID).Scan(&dlID)
	if err != nil {
		t.Fatalf("read dl id: %v", err)
	}
	op := Operator{Actor: "admin-1", Role: "admin", Reason: "incident closed"}

	// Dry run: preview recorded, nothing moved.
	preview, err := testStore.ResolveDeadLetter(ctxc(), dlID, engine.ForceTerminate, op, true)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if preview.State != engine.StateFailed {
		t.Fatalf("preview state = %s, want FAILED", preview.State)
	}
	if st, _ := queryWFState(t, wf.ID); st != string(engine.StateFailedManual) {
		t.Fatalf("dry run changed state: %s", st)
	}
	if n := count(t, `SELECT count(*) FROM operator_action WHERE workflow_id=$1 AND dry_run`, wf.ID); n != 1 {
		t.Fatal("dry-run operator_action missing")
	}

	// Real resolution.
	res, err := testStore.ResolveDeadLetter(ctxc(), dlID, engine.ForceTerminate, op, false)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.State != engine.StateFailed {
		t.Fatalf("resolved state = %s", res.State)
	}
	if n := count(t, `SELECT count(*) FROM dead_letter WHERE id=$1 AND resolved_by='admin-1' AND resolution='force-terminate'`, dlID); n != 1 {
		t.Fatal("DLQ item not resolved")
	}
	if n := count(t, `SELECT count(*) FROM operator_action WHERE workflow_id=$1 AND action='force-terminate' AND NOT dry_run`, wf.ID); n != 1 {
		t.Fatal("resolution operator_action missing")
	}
	// One-shot: a second attempt is a typed refusal, state stays terminal.
	if _, err := testStore.ResolveDeadLetter(ctxc(), dlID, engine.ForceTerminate, op, false); err == nil {
		t.Fatal("re-resolution must fail")
	} else {
		var already DeadLetterResolvedError
		if !errors.As(err, &already) {
			t.Fatalf("want DeadLetterResolvedError, got %v", err)
		}
	}
	// Unknown item: typed not-found (404 class), not a silent no-op.
	if _, err := testStore.ResolveDeadLetter(ctxc(), id.New(), engine.ForceTerminate, op, false); err == nil {
		t.Fatal("unknown DLQ id must fail")
	} else {
		var nf DeadLetterNotFoundError
		if !errors.As(err, &nf) {
			t.Fatalf("want DeadLetterNotFoundError, got %v", err)
		}
	}
}

func TestStore_ResolveCompleteCompensation(t *testing.T) {
	reset(t)
	// Drive W12: step 1 completes, its compensator then fails terminally.
	wf := seedRunning(t)
	apply(t, successEvent(wf.ID, "reserve-room", 1, wf.Version))
	wf = loadState(t, wf.ID)
	apply(t, failEvent(wf.ID, "charge-payment", 1, engine.ErrTerminal, wf.Version))
	wf = loadState(t, wf.ID)
	if wf.State != engine.StateCompensating {
		t.Fatalf("want COMPENSATING, got %s", wf.State)
	}
	apply(t, failEvent(wf.ID, "reserve-room", 1, engine.ErrTerminal, wf.Version))
	wf = loadState(t, wf.ID)
	if wf.State != engine.StateFailedManual {
		t.Fatalf("want FAILED_MANUAL after compensator terminal failure, got %s", wf.State)
	}
	var dlID string
	if err := testStore.Pool().QueryRow(ctxc(),
		`SELECT id FROM dead_letter WHERE workflow_id = $1 AND class='COMPENSATION'`, wf.ID).Scan(&dlID); err != nil {
		t.Fatalf("read dl id: %v", err)
	}
	res, err := testStore.ResolveDeadLetter(ctxc(), dlID, engine.CompleteCompensation,
		Operator{Actor: "admin-2", Role: "admin", Reason: "manually reconciled"}, false)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.State != engine.StateAborted {
		t.Fatalf("complete-compensation -> %s, want ABORTED", res.State)
	}
	// The outstanding compensable step is recorded COMPENSATED (operator's
	// judgement reflected in step history, REQ-OP-2).
	for _, st := range res.Steps {
		if st.Type == "reserve-room" && st.State != engine.StepCompensated {
			t.Fatalf("reserve-room step = %s, want COMPENSATED", st.State)
		}
	}
}

// ---- §5 definitions (A-T validation inputs) ---------------------------------

func TestStore_Definitions(t *testing.T) {
	reset(t)
	steps := json.RawMessage(`[{"type":"reserve-room","max_attempts":3,"compensable":true,"compensator_task":"release-room","forward_timeout_secs":45},{"type":"charge-payment","max_attempts":2}]`)
	d, err := testStore.RegisterDefinition(ctxc(), "room-reservation", 1, steps)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if len(d.Steps) != 2 || d.Steps[0].CompensatorTask != "release-room" ||
		d.Steps[0].ForwardTimeout != 45*time.Second || d.Steps[1].MaxAttempts != 2 ||
		d.Steps[1].ForwardTimeout != engine.DefaultResponseTimeout {
		t.Fatalf("parsed specs = %+v", d.Steps)
	}
	// Immutability: the same (name, version) is a typed conflict.
	if _, err := testStore.RegisterDefinition(ctxc(), "room-reservation", 1, steps); err == nil {
		t.Fatal("duplicate registration must conflict")
	} else {
		var dc DefinitionConflictError
		if !errors.As(err, &dc) {
			t.Fatalf("want DefinitionConflictError, got %v", err)
		}
	}
	// Validation failures never reach the table.
	bad := []json.RawMessage{
		json.RawMessage(`[]`),                                       // empty
		json.RawMessage(`[{"type":"a"},{"type":"a"}]`),              // duplicate types
		json.RawMessage(`[{"type":"a","max_attempts":0}]`),          // budget below 1
		json.RawMessage(`[{"type":"a","max_attempt":3}]`),           // unknown key (typo)
		json.RawMessage(`[{"type":"a","compensator_task":"x"}]`),    // compensator without compensable
		json.RawMessage(`[{"type":"a","forward_timeout_secs":-5}]`), // nonsense timeout
	}
	for i, b := range bad {
		if _, err := testStore.RegisterDefinition(ctxc(), fmt.Sprintf("bad-%d", i), 1, b); err == nil {
			t.Fatalf("bad steps %d accepted", i)
		} else {
			var de DefinitionError
			if !errors.As(err, &de) {
				t.Fatalf("bad %d: want DefinitionError, got %v", i, err)
			}
		}
	}
	// Active resolution: highest ACTIVE version; retiring uncovers the older.
	if _, err := testStore.RegisterDefinition(ctxc(), "room-reservation", 2, steps); err != nil {
		t.Fatalf("register v2: %v", err)
	}
	active, err := testStore.GetActiveDefinition(ctxc(), "room-reservation")
	if err != nil || active.Version != 2 {
		t.Fatalf("active = %+v err=%v, want v2", active, err)
	}
	if err := testStore.RetireDefinition(ctxc(), "room-reservation", 2); err != nil {
		t.Fatalf("retire: %v", err)
	}
	active, err = testStore.GetActiveDefinition(ctxc(), "room-reservation")
	if err != nil || active.Version != 1 {
		t.Fatalf("after retire active = %+v err=%v, want v1", active, err)
	}
	if _, err := testStore.GetDefinition(ctxc(), "room-reservation", 2); err != nil {
		t.Fatalf("retired definition must stay readable: %v", err)
	}
	if _, err := testStore.GetActiveDefinition(ctxc(), "nope"); err == nil {
		t.Fatal("absent definition must be typed NotFound")
	} else {
		var dnf DefinitionNotFoundError
		if !errors.As(err, &dnf) {
			t.Fatalf("want DefinitionNotFoundError, got %v", err)
		}
	}
	all, err := testStore.ListDefinitions(ctxc(), "room-reservation")
	if err != nil || len(all) != 2 {
		t.Fatalf("list = %+v err=%v", all, err)
	}
}

// ---- §7 pgoutbox relay store protocol (R-T items) ----------------------------

// R-T01: batch claim is exclusive per row; ack is owner-guarded; the
// checkpoint only moves forward; published rows never re-claim.
func TestStore_RelayClaimAck(t *testing.T) {
	reset(t)
	wf := seedRunning(t) // W2 command sits in the outbox, unpublished
	rows, err := testStore.ClaimOutboxBatch(ctxc(), "relayA", 10, DefaultLeaseTTL)
	if err != nil || len(rows) != 1 {
		t.Fatalf("claim rows=%d err=%v", len(rows), err)
	}
	r := rows[0]
	if r.WorkflowID != wf.ID || r.AggregateID != wf.ID || r.Topic != topicCommands ||
		r.Attempt != 1 || len(r.Payload) == 0 {
		t.Fatalf("bad relay row %+v", r)
	}
	// Envelope integrity: the identity block the relay must not rewrite.
	var env map[string]any
	if err := json.Unmarshal(r.Payload, &env); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if env["type"] != eventTypeCommand || env["subject"] != wf.ID || env["traceparent"] == "" || env["causation_id"] == "" {
		t.Fatalf("envelope missing identity block: %v", env)
	}
	// Second relay cannot see leased rows.
	if rows, err := testStore.ClaimOutboxBatch(ctxc(), "relayB", 10, DefaultLeaseTTL); err != nil || len(rows) != 0 {
		t.Fatalf("relayB claimed a leased row: %d err=%v", len(rows), err)
	}
	// A stale (non-owner) ack affects nothing.
	if n, err := testStore.AckPublished(ctxc(), "relayB", []int64{r.Seq}); err != nil || n != 0 {
		t.Fatalf("non-owner acked %d (err %v)", n, err)
	}
	if n := count(t, `SELECT count(*) FROM outbox WHERE published_at IS NOT NULL`); n != 0 {
		t.Fatal("non-owner ack published a row")
	}
	// Owner ack: row closed, checkpoint advanced.
	if n, err := testStore.AckPublished(ctxc(), "relayA", []int64{r.Seq}); err != nil || n != 1 {
		t.Fatalf("owner ack: %d err=%v", n, err)
	}
	cp, err := testStore.GetRelayCheckpoint(ctxc(), "relayA")
	if err != nil || cp != r.Seq {
		t.Fatalf("checkpoint = %d err=%v, want %d", cp, err, r.Seq)
	}
	if rows, err := testStore.ClaimOutboxBatch(ctxc(), "relayC", 10, DefaultLeaseTTL); err != nil || len(rows) != 0 {
		t.Fatalf("published row re-claimed: %d err=%v", len(rows), err)
	}
	// Monotonic checkpoint: acking an older seq must not rewind the cursor.
	if _, err := testStore.AckPublished(ctxc(), "relayA", []int64{1}); err != nil {
		t.Fatalf("ack stale: %v", err)
	}
	if cp, err := testStore.GetRelayCheckpoint(ctxc(), "relayA"); err != nil || cp != r.Seq {
		t.Fatalf("checkpoint rewound to %d (err %v)", cp, err)
	}
}

// R-T02: a crashed relay's claim becomes reclaimable once its lease expires —
// at-least-once redelivery, honestly duplicated.
func TestStore_RelayCrashRedelivery(t *testing.T) {
	reset(t)
	seedRunning(t)
	rows, err := testStore.ClaimOutboxBatch(ctxc(), "relayA", 10, 2*time.Second)
	if err != nil || len(rows) != 1 {
		t.Fatalf("claim: %d err=%v", len(rows), err)
	}
	// Simulate crash + lease expiry by backdating on the DB clock.
	if _, err := testStore.Pool().Exec(ctxc(),
		`UPDATE outbox SET claimed_until = now() - interval '1 second' WHERE seq = $1`, rows[0].Seq); err != nil {
		t.Fatalf("age claim: %v", err)
	}
	redelivered, err := testStore.ClaimOutboxBatch(ctxc(), "relayB", 10, DefaultLeaseTTL)
	if err != nil || len(redelivered) != 1 || redelivered[0].EventID != rows[0].EventID {
		t.Fatalf("no redelivery after lease expiry: %d err=%v", len(redelivered), err)
	}
	// The dead relay's late ack is now refused (owner moved): the ack guard
	// is what makes "stale relay cannot ack" true, not luck.
	if n, err := testStore.AckPublished(ctxc(), "relayA", []int64{rows[0].Seq}); err != nil || n != 0 {
		t.Fatalf("dead relay acked %d rows (err %v)", n, err)
	}
	// Live owner acks normally.
	if n, err := testStore.AckPublished(ctxc(), "relayB", []int64{rows[0].Seq}); err != nil || n != 1 {
		t.Fatalf("live ack: %d err=%v", n, err)
	}
}

// R-T03: bounded per-row policy — backoff between attempts (row not
// re-claimable until due), and RETRY_EXHAUSTED dead-letter at the budget,
// filed in the same transaction that marks the row failed.
func TestStore_RelayRetryExhausted(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	rows, err := testStore.ClaimOutboxBatch(ctxc(), "relayA", 10, DefaultLeaseTTL)
	if err != nil || len(rows) != 1 {
		t.Fatalf("claim: %d err=%v", len(rows), err)
	}
	seq := rows[0].Seq

	// First failure under a budget of 3: backoff, no DLQ.
	exhausted, err := testStore.PublishFailed(ctxc(), "relayA", seq, 3, "broker down")
	if err != nil || exhausted {
		t.Fatalf("first failure: exhausted=%v err=%v", exhausted, err)
	}
	var retryCount int
	var notDue bool
	err = testStore.Pool().QueryRow(ctxc(),
		`SELECT retry_count, next_retry_at > now() FROM outbox WHERE seq = $1`, seq).Scan(&retryCount, &notDue)
	if err != nil || retryCount != 1 || !notDue {
		t.Fatalf("backoff row: count=%d due=%v err=%v", retryCount, notDue, err)
	}
	// Not claimable while backing off.
	if rows, err := testStore.ClaimOutboxBatch(ctxc(), "relayB", 10, DefaultLeaseTTL); err != nil || len(rows) != 0 {
		t.Fatalf("backing-off row claimed: %d err=%v", len(rows), err)
	}
	// Not ours any more check: failure from a non-owner changes nothing.
	if exhausted, err := testStore.PublishFailed(ctxc(), "relayZ", seq, 3, "ghost"); err != nil || exhausted {
		t.Fatalf("ghost failure: %v err=%v", exhausted, err)
	}

	// Run the budget out (age the backoff between attempts).
	for i := 2; i <= 3; i++ {
		if _, err := testStore.Pool().Exec(ctxc(),
			`UPDATE outbox SET next_retry_at = NULL, claimed_until = NULL WHERE seq = $1`, seq); err != nil {
			t.Fatalf("clear backoff: %v", err)
		}
		rows, err := testStore.ClaimOutboxBatch(ctxc(), "relayA", 10, DefaultLeaseTTL)
		if err != nil || len(rows) != 1 {
			t.Fatalf("reclaim %d: %d err=%v", i, len(rows), err)
		}
		exhausted, err := testStore.PublishFailed(ctxc(), "relayA", seq, 3, "broker down")
		if err != nil {
			t.Fatalf("failure %d: %v", i, err)
		}
		if exhausted != (i == 3) {
			t.Fatalf("failure %d exhausted=%v", i, exhausted)
		}
	}
	// Exhausted: row failed forever, DLQ + audit filed atomically.
	if n := count(t, `SELECT count(*) FROM outbox WHERE seq=$1 AND failed_at IS NOT NULL`, seq); n != 1 {
		t.Fatal("row not marked failed")
	}
	if n := count(t, `SELECT count(*) FROM dead_letter WHERE workflow_id=$1 AND class='RETRY_EXHAUSTED'`, wf.ID); n != 1 {
		t.Fatal("RETRY_EXHAUSTED dead letter missing")
	}
	if n := count(t, `SELECT count(*) FROM audit_event WHERE workflow_id=$1 AND kind='DEADLETTER'`, wf.ID); n != 1 {
		t.Fatal("exhaustion audit missing")
	}
	if rows, err := testStore.ClaimOutboxBatch(ctxc(), "relayA", 10, DefaultLeaseTTL); err != nil || len(rows) != 0 {
		t.Fatalf("failed row re-claimed: %d err=%v", len(rows), err)
	}
}

// ---- §6 API read models ------------------------------------------------------

func TestStore_Reads(t *testing.T) {
	reset(t)
	wf := seedRunning(t)
	if _, ok := mustClaim(t, "w1"); !ok {
		t.Fatal("claim failed")
	}
	apply(t, successEvent(wf.ID, "reserve-room", 1, wf.Version))

	d, err := testStore.GetWorkflowDetail(ctxc(), wf.ID)
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if d.State != string(engine.StateRunning) || len(d.Steps) != 2 ||
		d.Steps[0].State != "SUCCEEDED" || d.Steps[0].LeaseHolder != nil ||
		d.Steps[1].StepType != "charge-payment" {
		t.Fatalf("detail = %+v", d)
	}
	// Lease visibility: step 2 was issued by W3, unclaimed yet — deadline set,
	// holder NULL.
	if d.Steps[1].ResponseDeadlineAt == nil || d.Steps[1].LeaseHolder != nil {
		t.Fatalf("step2 lease/deadline view = %+v", d.Steps[1])
	}
	if _, err := testStore.GetWorkflowDetail(ctxc(), id.New()); err == nil {
		var nf NotFoundError
		if !errors.As(err, &nf) {
			t.Fatalf("absent detail: %v", err)
		}
	}

	// Keyset list pages by id desc; cursor walk finds everything exactly once.
	for i := 0; i < 5; i++ {
		if _, err := testStore.CreateWorkflow(ctxc(), twoStepParams()); err != nil {
			t.Fatalf("extra create: %v", err)
		}
	}
	seen := map[string]bool{}
	cursor := ""
	for pages := 0; ; pages++ {
		page, err := testStore.ListWorkflows(ctxc(), "", "", cursor, 2)
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		for _, w := range page {
			if seen[w.ID] {
				t.Fatal("cursor re-served a row")
			}
			seen[w.ID] = true
		}
		if len(page) < 2 {
			break
		}
		cursor = page[len(page)-1].ID
		if pages > 10 {
			t.Fatal("cursor never terminated")
		}
	}
	if len(seen) != 6 {
		t.Fatalf("saw %d workflows, want 6", len(seen))
	}
	// State filter narrows exactly.
	queued, err := testStore.ListWorkflows(ctxc(), "QUEUED", "", "", 10)
	if err != nil || len(queued) != 5 {
		t.Fatalf("QUEUED list = %d err=%v", len(queued), err)
	}

	// Audit cursor by seq; inbound history keeps the classified envelope.
	audits, err := testStore.ListAudit(ctxc(), wf.ID, -1, 50)
	if err != nil || len(audits) < 3 {
		t.Fatalf("audits = %d err=%v", len(audits), err)
	}
	tail, err := testStore.ListAudit(ctxc(), wf.ID, audits[0].Seq, 50)
	if err != nil || len(tail)+1 != len(audits) {
		t.Fatalf("audit cursor: %d/%d err=%v", len(tail), len(audits), err)
	}
	inbound, err := testStore.ListInbound(ctxc(), wf.ID, time.Time{}, "", 10)
	if err != nil || len(inbound) != 1 || inbound[0].Classification == nil || *inbound[0].Classification != "APPLIED" {
		t.Fatalf("inbound = %+v err=%v", inbound, err)
	}
	attempts, err := testStore.ListAttempts(ctxc(), wf.ID)
	if err != nil || len(attempts) != 2 { // step1 SUCCEEDED + step2 opened ISSUED
		t.Fatalf("attempts = %+v err=%v", attempts, err)
	}

	// Metric gauges see the real rows they name. Pending commands: the two
	// steps this workflow advanced through + one first-step command per extra
	// QUEUED create (W1 emits the first issue intent).
	pending, oldest, err := testStore.OutboxPending(ctxc())
	if err != nil || pending != 7 || oldest <= 0 {
		t.Fatalf("pending = %d/%v err=%v, want 7 commands", pending, oldest, err)
	}
	byState, err := testStore.WorkflowsByState(ctxc())
	if err != nil || byState[string(engine.StateRunning)] != 1 || byState[string(engine.StateQueued)] != 5 {
		t.Fatalf("by-state = %v err=%v", byState, err)
	}
	if n, err := testStore.LeasesHeld(ctxc()); err != nil {
		t.Fatalf("leases: %v", err)
	} else if n != 0 {
		// w1's claim on step 1 was cleared when the success settled it
		// (syncSteps releases leases on every write-back).
		t.Fatalf("leases held = %d, want 0 after settle", n)
	}
	if n, err := testStore.DeadLettersOpen(ctxc()); err != nil || n != 0 {
		t.Fatalf("open DLQ = %d err=%v", n, err)
	}
	if lag, err := testStore.OutboxLag(ctxc(), "nobody"); err != nil || lag != 7 {
		t.Fatalf("lag = %d err=%v", lag, err)
	}
}

func TestStore_StoredResponses(t *testing.T) {
	reset(t)
	out, err := testStore.CreateWorkflow(ctxc(), twoStepParams())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	key := "" // recover the key from the ledger row the create wrote
	if err := testStore.Pool().QueryRow(ctxc(),
		`SELECT key FROM api_idempotency WHERE workflow_id = $1`, out.Workflow.ID).Scan(&key); err != nil {
		t.Fatalf("read key: %v", err)
	}
	if _, _, _, found, err := testStore.GetStoredResponse(ctxc(), key, time.Now()); err != nil || found {
		t.Fatalf("response before record: found=%v err=%v", found, err)
	}
	body, _ := json.Marshal(map[string]any{"id": out.Workflow.ID})
	if err := testStore.RecordStoredResponse(ctxc(), key, 201, body, []byte(`{}`)); err != nil {
		t.Fatalf("record: %v", err)
	}
	status, got, _, found, err := testStore.GetStoredResponse(ctxc(), key, time.Now())
	if err != nil || !found || status != 201 {
		t.Fatalf("replay = %d found=%v err=%v", status, found, err)
	}
	// jsonb normalises whitespace on store, so compare decoded values.
	var wantV, gotV any
	_ = json.Unmarshal(body, &wantV)
	if err := json.Unmarshal(got, &gotV); err != nil {
		t.Fatalf("decode stored: %v", err)
	}
	wb, _ := json.Marshal(wantV)
	gb, _ := json.Marshal(gotV)
	if string(wb) != string(gb) {
		t.Fatalf("stored body %s != recorded %s", gb, wb)
	}
}
