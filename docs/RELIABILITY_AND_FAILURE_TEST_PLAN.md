# Reliability & Failure Test Plan

Every Phase 1 defect and mandated failure scenario maps to at least one **acceptance test with an ID**. A test is "passing" only when executed in CI from a clean checkout — this document *plans*; it never claims. Naming convention: `TestFathom_<ID>_<slug>`; every defect-derived test carries its `DS-n` in a comment line referencing this doc.

**Rule inherited from Phase 1:** the audited repo had 0 tests and its central defect (DS-1) was only findable by hand-injecting an event. The point of this plan is that none of those scenarios is ever hand-checked again.

---

## 1. Test tiers and infrastructure

| Tier | Runs | Infra needed | Where executed |
| --- | --- | --- | --- |
| **T-EVENT** unit: pure engine transitions | ms | none (state struct + transition table; no DB, no broker) | CI job `unit` (`go test -race`) |
| **T-PROP** property-based: invariants over randomised transition/event sequences | ~min | none (`testing/fuzz` seed corpus, no external input) | CI job `unit` + nightly extended |
| **T-INT** integration: store SQL guards, migrations, constraints, reaper | ~min | **testcontainers-go** Postgres 17 only | CI job `integration` |
| **T-CONTRACT** event envelope golden files, both relay formats | ms–s | none (filesystem goldens) | CI job `contract` |
| **T-RELAY** relay conformance suite — the *same* suite against `pgoutbox` and `cdc-debezium` | ~min | compose profile: lite = Postgres; cdc = Postgres + `apache/kafka` + Debezium connect | CI jobs `relay-lite`, `relay-cdc` (cdc lane nightly + tag-gated) |
| **T-E2E** full-stack scenarios (lite relay) | ~min | compose lite stack, seed fixtures | CI job `e2e` |
| **T-CHAOS** process-kill / crash-window tests | ~min | compose stack + `kill -9` harness + restart, assertions on stored state | CI job `chaos` (nightly + pre-release) |

Windows host parity: `T-EVENT/T-PROP/T-CONTRACT` must run natively on Windows without CGO (probe evidence, ADR-005); DB-backed tiers use containers. CI primary runner is Linux; the Windows lane runs at least the pure tiers (kills DS-12-class regressions).

## 2. Acceptance tests mandated by the Phase 2 brief (all blocking)

| ID | Scenario (brief §6 wording) | Method | Pass criterion | Tier | Closes |
| --- | --- | --- | --- | --- | --- |
| **AT-01** | Duplicate **or stale** step event cannot reopen a terminal workflow | Drive a workflow to `COMPLETED` in T-E2E; then deliver (a) byte-identical redelivery, (b) a *re-authored* equivalent result with fresh `event_id` — exactly the Phase 1 §5.1 injection, now through the real relay path | `workflow.state/version/finished_at` unchanged; both events present in `inbound_event` classified `DUPLICATE` / `TERMINAL_IGNORED`; zero new outbox rows; no participant re-execution (inbox count stable) | T-E2E + T-EVENT | **DS-1**, DS-1b |
| **AT-02** | Same logical step never executes twice due to delivery retry | Deliver the same command to a participant twice (concurrently *and* sequentially) | `command_inbox` has one row for `(wf,step,attempt)`; business effect applied once; stored result replayed on second delivery | T-INT | DS-2 class, scenario 2 |
| **AT-03** | Concurrent workers cannot claim/execute one step without valid lease | N=8 parallel claimers for one issuable step; then kill "holder" mid-effect and let lease expire | exactly one valid claim; killed holder's late result classified `STALE`/refused by fencing (`attempt < active_attempt`); new attempt executes once | T-INT + T-CHAOS | scenario 9, DS-4 |
| **AT-04** | Crash after side effect, before ack/publish | `kill -9` participant between effect-commit and result-publish; restart | on redelivery: no second effect, result published exactly once; engine applies once | T-CHAOS | scenario 3 |
| **AT-05** | DB commit + relay crash ⇒ event not permanently lost | Commit a transition, kill relay before publish, restart relay (cursor unchanged), and separately: kill *between* publishes with cursor half-advanced | unpublished outbox rows (cursor behind `seq`) re-published; zero rows ever skipped (`seq` continuity audit); consumer-side dedup absorbs duplicates | T-CHAOS + T-RELAY | **DS-9**, scenario 1 |
| **AT-06** | Consumer restart & redelivery don't duplicate protected effects | Restart Kafka group / re-consume from earlier offset (CDC lane: restart Connect) | effects identical to no-restart run; `processed_events` absorbs; metrics show `DUPLICATE` counts > 0 (proof the path fired) | T-RELAY/T-CHAOS | scenario 8, DS-8 |
| **AT-07** | Compensation failure ⇒ durable visible manual-intervention state | Configure `release-room` compensator to fail terminally; drive step-2 failure | within one retry budget: `step.state=COMPENSATION_FAILED`, `workflow.state=FAILED_MANUAL`, `dead_letter` row class `COMPENSATION`, `compensation_failures_total` incremented, DLQ visible in API; **no loop after budget** | T-E2E | **DS-6** |
| **AT-08** | Timeouts & retry budgets guarantee defined outcome | Silence a participant's responses entirely (hang rule `…0000`) | step → `TIMED_OUT` → retries with increasing `attempt` → budget exhausted → `COMPENSATING`/`FAILED`; if still open at `deadline_at`, reaper lands it in `FAILED_MANUAL`; never open past `deadline + grace`; `oldest_open_workflow_age_seconds` reflects it | T-E2E + T-CHAOS | **DS-2**, scenario 10 |
| **AT-09** | 50 concurrent overlapping bookings ⇒ at most one valid hold | 50 parallel `POST /v1/workflows` same `room_id`, overlapping `daterange` | exactly 1 workflow holds a `room_stay` row; others `FAILED`/`409` (business-key rule may collapse them earlier — either outcome valid); constraint violation count 0; invariant asserted on **inventory table**, not saga status | T-E2E (parallel harness) | **DS-5**, scenario "boolean flag" |
| **AT-10** | Idempotency key: repeats create no workflows; audit is append-only | Same key+body ×3; same key+different body; then `UPDATE/DELETE audit_event` as app role | one workflow row; stored response replayed byte-identical with `Idempotency-Replayed`; `422` on mismatched reuse; permission errors on audit mutation | T-INT + T-E2E | **DS-8**, audit requirement |
| **AT-11** | Payment success semantics | Run capture-fails-after-auth path | step does **not** succeed on authorization alone; ledger shows `AUTHORIZATION` + `VOID/REFUND` entry; `CAPTURED` event is what advances | T-E2E | `REQUESTED`=success defect (audit §4.3 step 7→8) |
| **AT-12** | Terminal immutability as a *property* | T-PROP: randomised interleavings of results/timeouts/cancels/replays (≥10⁵ sequences nightly, 10³ CI) against the pure engine | invariant `is_terminal(state) ⇒ state unchanged forever` holds for every trace; also: `version` monotonic; every state change has exactly one audit row | T-PROP | **DS-1b** class |

## 3. Additional reliability requirements (not in the brief's list, same blocking status)

| ID | Requirement | Tier |
| --- | --- | --- |
| RT-01 | Recovery after **control-plane** restart mid-flight: kill engine + reaper, leave a workflow `RUNNING` with expired leases, restart ⇒ resumes, no double effects (relay + inbox absorb) | T-CHAOS |
| RT-02 | Prolonged participant outage: participant down > `deadline_at` ⇒ W13 lands `FAILED_MANUAL` + DLQ, existing completed steps compensated first | T-E2E |
| RT-03 | Out-of-order & late cross-workflow delivery: 4+ partitions, shuffled consumers — per-workflow sequencing still correct (key = `workflow_id`) | T-RELAY |
| RT-04 | Unparseable envelope: garbage into results topic ⇒ `UNPARSEABLE_EVENT` DLQ row, consumer never blocks (no poison-pill stall) | T-E2E |
| RT-05 | Bootstrap determinism: `compose up` from cold cache with **no** `sleep`s ⇒ all healthchecks green, connectors RUNNING / relay cursors initialised; run 3 consecutive times | CI setup step |
| RT-06 | SSE resume: cut stream at known `seq`, reconnect with `Last-Event-ID` ⇒ no missed audit events, exact continuation | T-E2E (http) |
| RT-07 | Relay independence: two `pgoutbox` instances concurrently ⇒ every committed row published **at least once** with per-`seq` continuity, claims never double-executed (`SKIP LOCKED` cursor contract); duplicate *delivery* is permitted by design and must be absorbed downstream like any duplicate | T-RELAY |
| RT-08 | Config hygiene (CI grep gates): no credential material in tracked files — patterns cover `password:`, DSN `user:pw@` inline credentials (allow-listing `changeme-`/`changeme-local` fake markers and `.env.example`), and key-looking entropy strings; every `bootstrap.servers`/DSN value bare `host:port` (DS-10's parse-warning class is a **build-breaking** lint); image references pinned by tag+digest | CI job `hygiene` |

## 4. Coverage and regression discipline

- Coverage gate: `internal/engine/…` ≥ **85%** statements (the Phase 1 engine had 0% of anything); repo-wide ≥ 65%.
- **Defect-naming rule** (carried from Phase 1 roadmap): every future incident adds `TestFathom_DS<n>_*` here before the fix is merged — the table above is append-only history, not a checklist to forget.
- Race detector mandatory on all Go tiers (`-race`); `-race` on Windows lane as well.
- Fuzz corpus for AT-12 checked into `tests/fuzz/` (deterministic seeds; CI no randomness — nightly extends budget).

## 5. What "verified" will mean at each phase gate

Phase 3 gates cite these IDs strictly: **P-engine** = AT-01 (as unit + e2e), AT-12, AT-02, AT-10(partial); **P-reliability** = AT-03, AT-07, AT-08, RT-01/02; **P-relay** = AT-05, AT-06, AT-11-lite, RT-03/04/07 + AT-09; nothing is reported "done" without its CI job URL/exit code, in the pattern Phase 1 §3 established (PASSED / FAILED / SKIPPED / BLOCKED, no adjectives).
