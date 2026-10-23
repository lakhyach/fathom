# Workflow State Machine — normative

This document is the **single source of truth** for engine semantics. Implementation, tests, and UI all cite it. It exists because Phase 1 proved the alternative — deriving status from a value set — silently revokes terminal states (`DS-1`, reproduced live: `COMPLETED → ABORTED` from one replayed event; `src/pkg/saga/saga.go:41-56` in the audited repo).

Design rule that closes that class of bug: **status is stored per row and changed only by an enumerated transition; nothing is ever re-derived from collected values.**

---

## 1. Hierarchy

```
WorkflowDefinition (name, version, steps[], immutable once used)
└── Workflow (instance: state, version, business_key, deadline)
    └── Step (per declaration: state, version, active_attempt, timings)
        └── Attempt (per execution: number, lease, timings, outcome, error class)
```

A definition is `{ step_type, task, input, output, forward_timeout, response_timeout, retry{max_attempts, backoff, jitter}, compensator{task, timeout, retry} }`. Steps execute **in declaration order**; compensation executes in **reverse order over completed steps only**. The definition snapshot is copied onto the workflow instance at creation (instance pins its definition version forever).

## 2. Workflow states

| State | Terminal? | Meaning |
| --- | --- | --- |
| `QUEUED` | no | created; first step not yet issued |
| `RUNNING` | no | a step is issued/in progress/awaiting result |
| `RETRY_WAITING` | no | active attempt failed retryably; next attempt scheduled at `next_attempt_at` |
| `COMPENSATING` | no | forward execution stopped; compensators running in reverse over completed steps |
| `CANCELLING` | no | operator/client cancel accepted; current step is being compensated or wound down |
| `COMPLETED` | **YES ★** | all forward steps succeeded |
| `FAILED` | **YES ★** | a forward step failed terminally (business failure or retry budget exhausted) **before any compensation was needed**, or compensation set is empty |
| `ABORTED` | **YES ★** | forward failure fully compensated — effects rolled back |
| `FAILED_MANUAL` | **no †** | compensation failed or invariant breach: human intervention required; only an authorized operator action can move it to `ABORTED`/`FAILED` (audited) |

★ **Immutability (REQ-C-1):** no event, timer, concurrent transition, or relay replay can move a workflow out of `COMPLETED`/`FAILED`/`ABORTED`. Enforced *twice*: the transition table contains no outbound edge, **and** the SQL guard (and-state-list) makes any rogue `UPDATE` affect 0 rows. Inbound events touching a terminal workflow are recorded + classified `TERMINAL_IGNORED`.
† `FAILED_MANUAL` is deliberately non-terminal so operators can act, but it is **inert**: no automatic timer or event ever advances it.

### Transition table (exhaustive; anything not listed is illegal)

| # | From | To | Trigger | Guards (all must hold in one tx) | Side effects (same tx) |
| --- | --- | --- | --- | --- | --- |
| W1 | — | `QUEUED` | `POST /v1/workflows` | idempotency key new-or-matching; `business_key` has no active workflow (partial unique) | workflow row v1; step rows created; `api_idempotency` row; audit `WORKFLOW_CREATED`; outbox: issue step 1 |
| W2 | `QUEUED` | `RUNNING` | engine issues first command | row `version` match | audit; `started_at` |
| W3 | `RUNNING` | `RUNNING` | step succeeded, more steps remain | result event names active step + current attempt; `version` match | step→`SUCCEEDED`; next step issued; audit; outbox command |
| W4 | `RUNNING` | `RUNNING` | step succeeded, last step | as W3 | workflow→(goes via W9 instead) |
| W5 | `RUNNING` | `RETRY_WAITING` | attempt failed `RETRYABLE` **or** response deadline hit, budget left | attempt no. match; `attempts_used < max` | attempt→`FAILED/TIMED_OUT`; `next_attempt_at=now()+backoff(attempt)+jitter`; audit `RETRY_SCHEDULED` with `reason_code` |
| W6 | `RETRY_WAITING` | `RUNNING` | due time reached (scheduler) | `now() ≥ next_attempt_at`; lease free | new `attempt` row (n+1 = fencing token); outbox command re-issue; audit |
| W7 | `RUNNING`/`RETRY_WAITING` | `COMPENSATING` | forward step failed terminally (budget exhausted or `TERMINAL` class) | version match; ≥1 completed step exists | audit `COMPENSATION_STARTED`; outbox: compensator of last completed step |
| W8 | `RUNNING`/`RETRY_WAITING` | `FAILED` | forward step failed terminally, **no** completed steps to compensate | version match | audit; reservation-facing outcome `FAILED` |
| W9 | `RUNNING` | `COMPLETED` ★ | result of final step succeeded | version match | audit; `completed_at` |
| W10 | `COMPENSATING` | `COMPENSATING` | a compensator succeeded, more remain | as W7 chain | previous step→`COMPENSATED`; outbox next compensator |
| W11 | `COMPENSATING` | `ABORTED` ★ | last compensator succeeded | version match | audit `WORKFLOW_ABORTED` |
| W12 | `COMPENSATING` | `FAILED_MANUAL` | compensator failed terminally (its own budget exhausted) | version match | `dead_letter` row (class `COMPENSATION`); audit `COMPENSATION_FAILED`; metric `compensation_failures_total` |
| W13 | `RUNNING`/`RETRY_WAITING`/`COMPENSATING` | `FAILED_MANUAL` | workflow `deadline_at` exceeded; reaper acts | reaper holds row (`SKIP LOCKED`); still non-inert | if completed steps: compensators first via W7 chain, else direct; `dead_letter` row (class `DEADLINE`); audit `DEADLINE_ESCALATED` |
| W14 | `QUEUED` | `FAILED` ★ | cancel before anything ran | version match | audit only |
| W14b | `RUNNING`/`RETRY_WAITING` | `CANCELLING` | `POST …/actions:cancel` (role ≥ operator) | version match | audit with actor+reason; current step: allowed to finish (result applied normally) or lease released |
| W15 | `CANCELLING` | `ABORTED` ★ | completed steps compensated (W10 chain) | as W11 | audit |
| W16 | `CANCELLING` | `FAILED` ★ | nothing was completed | — | audit |
| W17 | `FAILED_MANUAL` | `ABORTED` / `FAILED` | **operator action only** (`force-terminate`, `complete-compensation`) | role `operator`/`admin`; reason string present; action recorded in `operator_action` with pre-state snapshot | audit `MANUAL_RESOLUTION`; DLQ entry resolved |
| W18 | `RETRY_WAITING` | `RUNNING` | manual `retry-now` (operator) | role; reason; audit | immediate attempt issue (bypasses backoff, counts same attempt) |

Reaper (W13/W6 driver) is a loop: `SELECT … WHERE (state IN (RUNNING,RETRY_WAITING,COMPENSATING,CANCELLING) AND (deadline_at < now() OR next_attempt_at <= now())) FOR UPDATE SKIP LOCKED LIMIT n` — safe with N replicas.

## 3. Step states

`PENDING → ISSUED → IN_PROGRESS → SUCCEEDED`
`IN_PROGRESS → FAILED → (retry: new attempt → ISSUED) | (terminal: compensation decision)`
`ISSUED/IN_PROGRESS → TIMED_OUT` (response deadline, engine-side)
`SUCCEEDED → COMPENSATION_PENDING → COMPENSATING → COMPENSATED | COMPENSATION_FAILED`

- Step row holds `active_attempt`, `lease_holder`, `lease_expires_at`, per-attempt timings.
- `COMPENSATION_FAILED` never retries silently beyond its declared budget; at exhaustion it triggers W12.

## 4. Attempt lifecycle and leasing

1. **Claim:** a worker takes the step command (from topic/inbox); it is valid only while `attempt` equals the step's current attempt **and** the lease hasn't expired. The DB-side claim of work by the *engine* onto a command queue uses `SKIP LOCKED`; the participant records `(workflow_id, step_type, attempt)` in its own inbox **inside the side-effect transaction** (the audited `eventlog` pattern, generalized).
2. **Fencing:** `attempt` is monotonically increasing and is the fencing token. A superseded attempt (`attempt < active_attempt`) must be refused by the participant with `STALE_ATTEMPT` (no side effect) — closes the Phase-1 scenario 9 family (two live executions of one logical step).
3. **Heartbeat:** long steps may extend `lease_expires_at`; expiry ⇒ engine marks attempt `LOST`, schedules a new attempt under the same idempotent command key. A late result from the lost attempt is classified `STALE`, stored, ignored.
4. **Worker crash after side effect, before result publish:** participant's inbox row was committed with the effect; on redelivery of the same command the effect is a no-op and the stored result is re-published → **exactly one effect per (step, attempt)** even across crashes (Phase 1 scenario 3, this time by design; verified by `AT-04`).

## 5. Inbound event classification (engine ingress, always in one tx)

| Class | Test (evaluated in order) | Effect |
| --- | --- | --- |
| `DUPLICATE` | `event_id` already in `processed_events` | no state change; audit counter |
| `TERMINAL_IGNORED` | workflow state ∈ {`COMPLETED`,`FAILED`,`ABORTED`} | **no state change**; audit row *(the DS-1 closure)* |
| `UNSOLICITED` | event names no active/non-terminal step of this workflow | no state change; metric; audit |
| `STALE` | event's `step_type` ≠ active step, or `attempt` < step's active attempt | no state change; audit |
| `APPLIED` | names active step + current attempt + non-terminal workflow | the §2 transition fires, `processed_events` insert, version bump |

Every inbound envelope is **stored raw** in `inbound_event` before classification — replay-inspection and the cockpit event-history view read this table, so "ignored" never means "invisible".

## 6. Outbox atomicity & relay checkpoints

**Rule (single, testable):** one transaction = one state change + all `outbox` rows describing it. Never publish inside a transaction; never do remote I/O inside one.

- `outbox.seq BIGINT GENERATED ALWAYS AS IDENTITY` is the global monotonic order; relays keep their own cursor row (`relay_name PK, last_published_seq`) → multi-instance relays are independent and checkpointed (fixes DS-9: rows are marked, prunable, replay is intentional).
- **Crash between commit and publish** ⇒ row still unpublished (cursor behind seq) ⇒ re-published. At-least-once, never lost (`AT-05`).
- `published_at` set by pgoutbox relay on ack; CDC relay mode marks published via a documented confirmation path; retention job prunes published rows older than N days **while `inbound_event`/`audit_event` remain the permanent record**.

## 7. Dead-letter semantics

`dead_letter` is a **queue of durable operator work items**, not an error dump: `{ id, workflow_id, step_type, attempt, class(RETRY_EXHAUSTED|COMPENSATION|DEADLINE|UNPARSEABLE_EVENT|LEASE_LOST), reason_code, raw_event_ref, created_at, resolved_at, resolved_by, resolution }`. Insert is in the same tx as the state change that caused it. Replay from DLQ = an *engine* operation (W17/W18) that mints a new attempt under guards — never a raw re-emit into a topic (which is precisely the manual action that corrupted state in Phase 1 §5.1).

## 8. Timings and backoff (normative defaults, per-step overridable)

| Field | Default | Enforced by |
| --- | --- | --- |
| `workflow.deadline_at` | 15 min from creation | reaper → W13 |
| `step.forward_timeout` (issue→result) | 60 s | reaper → W5/W7 |
| `step.retry.max_attempts` | 3 | W5 guard |
| backoff | `base 2s × 2^(n−1)`, full jitter, cap 60 s | W6 due-time |
| `compensator.response_timeout` | 60 s | W12 path |
| lease TTL | 90 s (heartbeat extends) | attempt `LOST` |

## 9. Guarantees this machine provides — and does not

**Provides:** (1) at-least-once delivery everywhere; (2) **exactly-once effect per (workflow, step, attempt)** via §4.4 + §5 + version guards; (3) **terminal immutability** (REQ-C-1, dual-enforced); (4) **bounded progress**: every workflow reaches terminal ∪ `FAILED_MANUAL` within `deadline_at` + reaper interval (REQ-C-5) — *given Postgres availability and ≥1 reaper replica*, which is stated as a dependency, not hidden; (5) ordering per workflow via `workflow_id` partition key; cross-workflow order is explicitly **not** promised.

**Does not provide:** global exactly-once processing; cross-partition/global ordering; recovery when the consensus store itself is lost (that's DB backup territory); non-idempotent external side effects without participant cooperation — the contract *requires* a participant either to dedupe by command key or to expose a reconciliation hook; we will document this boundary per participant rather than claim it away.

## 10. Cancellation edge rules

- Cancel during `QUEUED` → straight to `FAILED` (nothing ran).
- Cancel during `RUNNING`: the in-flight attempt is *not* killed (no illusion of a distributed abort); its result is recorded, then compensation proceeds over completed steps (W14b→W15). During `CANCELLING` the W3/W9 forward edges are disabled: a final-step success is still recorded `SUCCEEDED` but the workflow compensates it and terminates `ABORTED`, never `COMPLETED`.
- Cancel during `COMPENSATING` → rejected `409` (already unwinding).
