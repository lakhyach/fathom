# Product Specification — Fathom (codename)

**Status:** normative specification, Phase 2. Nothing here is a claim that a capability exists — every requirement is unimplemented until a named test in `RELIABILITY_AND_FAILURE_TEST_PLAN.md` passes.
**Evidence base:** the Phase 1 audit of [`semotpan/saga-orchestration-go`](https://github.com/semotpan/saga-orchestration-go) (defect IDs `DS-1…DS-14`, six audit documents retained in the original development workspace).

---

## 1. One-line product

A distributed workflow control plane whose failure modes are *observable, provable, and safely operable* — the opposite of the audited demo, where a replayed message silently corrupted a completed workflow (Phase 1 baseline results §5.1).

## 2. Users

| Persona | Needs |
| --- | --- |
| **Operator** (primary) | See every workflow's true state and history; understand every retry/timeout/compensation decision *with its reason*; resolve stranded or dead-lettered work safely. |
| **Developer** | Integrate a participant service via a small, versioned event contract; run the whole system locally in one command; reproduce any production failure from stored data. |
| **Evaluator / viewer** | Watch a deterministic demo — success, failure, compensation, recovery — and see the guarantees hold under injected faults, without touching SQL. |

## 3. Operator workflows (each is testable, each maps to acceptance criteria)

Every workflow below assumes the RBAC states in §7. `REQ-OP-n` IDs are referenced by the test plan and roadmap.

**REQ-OP-1 — Start a workflow.** `POST /v1/workflows` with a validated request body and a client `Idempotency-Key`. Same key + same body ⇒ identical stored response (no second workflow). Same key + different body ⇒ `422`. *(closes DS-8)*
**Accept:** repeated POST yields exactly one `workflow` row; response body/status are byte-identical on replay.

**REQ-OP-2 — Inspect execution state.** Workflow detail shows: current state and version, every step, every attempt with timings, lease holder, deadlines, and the full event history — all read from persisted rows, never inferred or animated.
**Accept:** every displayed field is traceable to a column in `DATA_AND_API_CONTRACTS.md` §A; the UI has no data path that can render a value not present in the API response.

**REQ-OP-3 — See retry/timeout decisions with reasons.** Every engine decision (retry, time out, abandon, compensate, dead-letter) writes an `audit_event` row carrying a machine-readable `reason_code` and human-readable detail. The timeline renders these as first-class entries.
**Accept:** for any transition into `RETRY_WAITING`, `TIMED_OUT`, or `DLQ`, a query by `workflow_id` returns the decision row that caused it.

**REQ-OP-4 — Inspect failed compensation and escalate.** `COMPENSATION_FAILED` is a durable, visible step outcome; the workflow lands in `FAILED_MANUAL` with a DLQ entry; an operator can attach an escalation note. *(closes DS-6)*
**Accept:** injecting a compensator failure yields, within one retry budget: a `dead_letter` row, `workflow.state = FAILED_MANUAL`, and a metric increment — with zero silent loops.

**REQ-OP-5 — Recover dead-lettered work safely.** Operator actions (`retry`, `compensate`, `force-terminate`) are explicit API calls requiring `operator` role, a mandatory reason string, dry-run support, and an audit record including the pre-action state snapshot. Raw event re-emission is **not** an available action. *(the DS-1 antidote — replay must be an intentional, guarded engine operation)*
**Accept:** a terminal workflow cannot be re-opened by any sequence of inbound events (property test), but an authorized `force-terminate` on a `FAILED_MANUAL` workflow succeeds and is fully audited.

**REQ-OP-6 — Trace across service boundaries.** Every command/result carries W3C `traceparent` + `causation_id`; a Jaeger instance in the local stack shows the full cross-service step path for any workflow; the cockpit links to the trace. *(closes DS-14)*
**Accept:** given a workflow id, its trace contains spans from control plane, relay, and each participating worker.

**REQ-OP-7 — Deterministic demonstration.** One command (`make demo` / `task demo`) seeds fixtures and runs: success path, business-failure path with compensation, timeout path with retry, stale/replay-rejection path, and worker-crash lease-recovery path — printing the stored evidence after each.
**Accept:** the demo is idempotent (repeatable from a reset stack to the same final states), and its assertions are the same tests as the CI acceptance suite.

## 4. Engine correctness requirements (R-normative; UI must never contradict them)

1. `REQ-C-1` Terminal workflow states (`COMPLETED`, `FAILED`, `ABORTED`) are immutable: no inbound event, timer, or concurrent transition can move a workflow out of them. `FAILED_MANUAL` is *not* terminal until an authorized operator action closes it.
2. `REQ-C-2` An inbound step result is applied only if it names the workflow, the active step, and the current attempt; everything else is stored, classified (`DUPLICATE | STALE | UNSOLICITED | TERMINAL_IGNORED`), and has zero state effect.
3. `REQ-C-3` Every state change is a version-guarded single-row update; lost races are detected, never silently overwritten.
4. `REQ-C-4` A step is executed by at most one live lease holder; a dead holder's lease expires and the retry runs under a new attempt with a fencing token the participant must check.
5. `REQ-C-5` Every non-terminal workflow is guaranteed to reach a terminal or `FAILED_MANUAL` state within its `deadline_at` plus scheduler grace — enforced by the reaper, measurable by `oldest_open_workflow_age_seconds`.
6. `REQ-C-6` A committed state change is never lost by relay downtime or crash: publication is outbox-based, checkpointed, at-least-once, and independently resumable per relay instance.
7. `REQ-C-7` Participant side effects are idempotent per `(workflow_id, step_type, attempt)` — the guarantee is *at-least-once delivery + exactly-once effect per step-attempt*, never "exactly-once processing" (§6).

## 5. Presentation requirements (separate from correctness)

- `REQ-U-1` The cockpit renders **only** persisted execution data (API/SSE). No optimistic client-side state, no progress animation not backed by a stored transition, no metric without a backend source.
- `REQ-U-2` Anything synthetic (demo fixtures, failure-injection lab actions) is visually labelled as synthetic/demo.
- `REQ-U-3` Reconnect is loss-free: SSE resumes from `Last-Event-ID` and backfills from the audit sequence.
- `REQ-U-4` Dark, minimal, professional; refined typography and motion; explicitly **not** a generic admin-template look. Every control corresponds to a real API call or is absent.

## 6. Delivery and consistency guarantees — stated honestly

| Layer | Guarantee we promise | What we explicitly do **not** claim |
| --- | --- | --- |
| Transport (pgoutbox relay, Kafka) | At-least-once publication of committed rows; per-workflow ordering via `workflow_id` partition key | No transactional producer/consumer "exactly-once stream" claims |
| Engine state | Exactly-once **effect** per `(workflow, step, attempt)`: one guarded transition applies; re-delivery is a classified no-op | Not "exactly-once event processing" — events *are* processed (read, stored, classified), they just cannot change state twice |
| Participant side effects | Idempotency per command key + fencing-token rejection of superseded attempts | We cannot make non-idempotent external APIs exactly-once; where an external system can't dedupe, the contract requires a reconciliation hook (documented per participant) |
| Progress | Every workflow terminates or escalates within bounded, configured time (`REQ-C-5`) | No unbounded-throughput or scale claims; capacity numbers are measured before being stated, in Phase 7 |

## 7. Security & multi-tenancy scope

Single-tenant demo product with **real** (not theatrical) auth boundaries: roles `reader`, `operator`, `admin`; session cookie + CSRF for the cockpit; API key for programmatic access; every operator action audited with actor, reason, before/after snapshot. No credentials in tracked files; env injection only. Multi-tenancy is **out of scope** (it inflates the schema without adding a demonstrable guarantee).

## 8. Domain showcase — room reservation, made credible

The audited demo's domain stays (it is the right size to demonstrate sagas), but the toy aspects are fixed because the cockpit must not demo fake correctness:
- **Date-range inventory** (replaces the global `available` boolean the audit found — DS-5): overlapping bookings for the same room are impossible by a database constraint, not by consumer serialization luck.
- **Payment ledger** (replaces the single-row `payment` table where a refund row was structurally impossible — DS-7): append-only `authorization → capture | void`, `refund`; the `CAPTURED` event is what marks the payment step succeeded (the audit showed `REQUESTED`-as-success meant "a payment was requested", not "money moved").
- **Third saga step** (confirmation): the two-step saga never exercised mid-saga compensation ordering; three steps do.

## 9. Out of scope (deliberate exclusions, revisited only with a concrete requirement)

Kubernetes/Helm; service mesh; schema registry; multi-region; multi-tenant isolation; billing; horizontal-scale claims; generic "workflow builder" UI; cron/scheduler product; distributed tracing backend beyond a local Jaeger.

## 10. Success criteria for the portfolio product

1. A reviewer can break the system in the failure-injection lab and watch every guarantee either hold or fail **loudly** (visible escalation, never silent corruption) within a 10-minute walkthrough.
2. The DS-1 replay scenario from Phase 1 is a named, passing regression test (`AT-01`) and a cockpit demo moment.
3. CI runs unit/property/integration/contract/e2e/chaos lanes reproducibly from a clean clone on Linux (and the host build works on Windows without CGO).
4. Every public claim in the README maps to a test ID or metric.
