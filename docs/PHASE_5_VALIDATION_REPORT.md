# Phase 5 Validation Report — Worker Execution, Recovery Scheduler, HTTP API & Outbox Relay

Date: 2026-10-23. Branch: `main`, HEAD before this work: `12b0d71` (Phase 4).
Scope decisions, gaps and deviations were recorded **before coding** in
`docs/PHASE_5_SPEC_CHECKLIST.md`; this report records what was built and the
**evidence** it works.

Honesty rule (brief §3): every result below is **real captured output** from
the validation run, marked **PASS / FAIL / BLOCKED / NOT RUN**. Nothing that
did not run is claimed as passing.

---

## 1. Environment

| Component | Value | Notes |
| --- | --- | --- |
| Dev host OS | Windows 25H2, pwsh | Static/build/cross/wiring gates run natively here. |
| Host Go | `go1.26.5 windows/amd64` | Matches `go 1.26.5` in `go.mod`. |
| Host gcc | **absent** | Host `go test -race` remains BLOCKED-on-host (documented, ADR-004); discharged natively in §4. |
| Container engine | Docker Engine 29.x | Native-Linux race runs + disposable PostgreSQL. |
| Native-Linux race toolchain | `golang:1.26.5-bookworm` (`go1.26.5 linux/amd64`, `gcc 12.2.0`) | Genuine Linux execution of `-race`, unit **and** integration tiers — not a cross-compile presented as a race run. |
| Durable DB under test | `postgres:17.11-alpine` (container `fathom-pg17`, host port 5434) | `fathom_test` database. Throwaway; all DSNs use local dev creds and none are committed. The race container reached it over the Docker bridge gateway (`172.17.0.1:5434`). |

**Product module dependencies (verified `go.mod`, `go mod verify` = all modules verified):** five pinned direct deps — `github.com/google/uuid v1.6.0`, `github.com/jackc/pgx/v5 v5.11.0`, `github.com/golang-migrate/migrate/v4 v4.20.1` (Phase 4), plus **new in Phase 5**: `github.com/twmb/franz-go v1.22.2` and `github.com/prometheus/client_golang v1.25.0`. All pure Go; CGO=0 re-proven (§3).

---

## 2. Required validation gates (brief §11)

| # | Gate | Status | Evidence (summary) |
| --- | --- | --- | --- |
| 1 | Formatting (`gofmt -l -s .`) | **PASS** | no files listed |
| 2 | `go vet ./...` (product) | **PASS** | exit 0 |
| 2b | `go vet ./...` (tools module) | **PASS** | exit 0 |
| 3 | Static analysis (staticcheck v0.8.2) product | **PASS** | exit 0, no findings |
| 3b | Static analysis (tools) | **PASS** | exit 0, no findings |
| 4 | All unit tests (`go test ./...`, no tag, no DB) | **PASS** | 66 PASS / 0 FAIL; integration files compile out and their packages report `[no test files]` (skip-when-unset design holds) |
| 5 | Race on supported Linux (native container) | **PASS** | §4: untagged `-race ./...` green **and** full `-race -tags integration -p 1 ./...` green, zero data-race reports |
| 6 | CGO-disabled build | **PASS** | `CGO_ENABLED=0 go build ./...` product exit 0 |
| 6b | Cross-compile `linux/amd64` | **PASS** | exit 0 |
| 6c | Cross-compile `linux/arm64` | **PASS** | product exit 0 (tools module also built under the cross GOOS) |
| 7 | Fresh PostgreSQL schema + 0002 migration | **PASS** | §5: `DROP SCHEMA public CASCADE` → full integration suite from nothing → schema **version 2, dirty=false**, 13 tables, `response_body TEXT` present (proves the amended 0002 itself, not a hand-patched DB) |
| 8 | All PostgreSQL integration tests | **PASS** | 129 PASS / 0 FAIL / 0 SKIP across api, store, worker, relay, metrics, health, engine, config (+ carried Phase-4 suites) |
| 9 | Concurrency + repeatable idempotency | **PASS** | concurrent same-key create → 1 workflow; two-worker claim contention; two-relay ack mutual exclusion; stale-after-reclaim refusal; all re-run under `-race` clean and with `-count=1` (no cache) |
| 10 | Secret / hygiene checks | **PASS** | `internal/hygiene` ok (incl. amended `.env.example` fake-values test); manual regex scan of Go sources for credential patterns → 0 matches; `Secret` redaction tests cover the new `FATHOM_API_KEYS` field |
| 11 | `git diff --check` | **PASS** | exit 0, no whitespace/conflict markers |
| 12 | Live process wiring smoke (brief §9.14 / Z-T1) | **PASS** | §6: one binary, four modes; end-to-end HTTP create → worker echo execution → `COMPLETED`; honest refusals proven by exit codes |
| 13 | Review of all changed + untracked files | **PASS** | full-diff review at commit time (recorded in the commit-stage checklist) |
| — | GitHub Actions CI run (`ci.yml`) | **NOT RUN** | repo has no remote (ADR-001); the full equivalent gate set was executed locally instead, on both hosts. |

---

## 3. Static + build gates (Windows host, captured)

```
### gofmt -l -s . ###            (empty)                 exit 0
### go vet ./... (product) ###   exit 0
### go vet ./... (tools) ###     exit 0
### staticcheck v0.8.2 product ###  (no findings)       exit 0
### staticcheck v0.8.2 tools ###    (no findings)       exit 0
### go test ./... (no tag, no DB) ###  66 PASS / 0 FAIL exit 0
### CGO_ENABLED=0 go build ./... ###         host=0
### GOOS=linux GOARCH=amd64 go build ###     exit 0
### GOOS=linux GOARCH=arm64 go build ###     exit 0   (product; tools cross-built too)
### go mod verify ###     all modules verified
### go mod tidy -diff ### (empty) — no drift
### git diff --check ###  (clean)
```

---

## 4. Race — native Linux execution (`golang:1.26.5-bookworm`)

The host has no gcc, so the race gate ran **inside a real Linux container**
(`go1.26.5 linux/amd64`, gcc 12.2.0), reaching PostgreSQL over the Docker
bridge gateway. Both tiers ran with `-count=1` (no result caching):

**4a. Untagged suite (`go test -race ./...`):** all 8 test packages `ok`, zero
race reports.

**4b. Full integration tier (`go test -race -tags integration -p 1 ./...`):**

```
ok  github.com/lakhyach/fathom/internal/api             2.041s
ok  github.com/lakhyach/fathom/internal/metrics         1.145s
ok  github.com/lakhyach/fathom/internal/relay           3.227s
ok  github.com/lakhyach/fathom/internal/store/postgres  2.195s
ok  github.com/lakhyach/fathom/internal/worker          6.043s
(+ app, config, engine, health, hygiene, id, logging — all ok)
```

The Phase-5 concurrency evidence (worker claim contention, lease reclaim under
heartbeat races, two-relay claim exclusion, concurrent idempotent creates,
rate-limiter map access, scheduler-vs-worker races) executed under the detector
with **zero data-race reports**. Command (reproducible):

```
docker run --rm -v .:/src -v fathom-gomod:/go/pkg/mod -w /src \
  -e CGO_ENABLED=1 \
  -e FATHOM_TEST_DATABASE_URL=postgres://…@172.17.0.1:5434/fathom_test?sslmode=disable \
  golang:1.26.5-bookworm sh -c "go test -race -tags integration -p 1 -count=1 ./..."
```

---

## 5. Fresh schema + full durable suite

`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` — then the **entire**
integration tier against the empty database, proving migration 0001 **and the
amended 0002** apply from nothing through the embedded migrator:

```
all 12 test packages ok (0 failures)
fathom_schema_migrations → version=2, dirty=false
13 tables; api_idempotency.response_body data_type = text   (0002's TEXT amendment proven from the file, not a hand-patched DB)
```

`TestStore_MigrateDownRoundTrip` (0002 → 0001 → 0002) PASSes inside the same
tier, including the down-path reversal of the `response_body` column type.

---

## 6. Process wiring smoke — one binary, four modes (brief §9.14)

Executed against the live `fathom-pg17` with the freshly built CGO=0 binary.

| Probe | Result |
| --- | --- |
| `fathom` (mode `all`, no brokers, `FATHOM_DEV_ECHO=1`) | boots: store migrated, **WARN relay not started (no brokers)**, **WARN echo is a SAMPLE**, worker+scheduler+API started, 4 components registered |
| admin register definition → `POST /v1/definitions` | **201** |
| operator `POST /v1/workflows` (Idempotency-Key) | **201 QUEUED**, `Location` header |
| worker loop claims `echo`, executes, submits leased result | log: `claimed → result applied` |
| `GET /v1/workflows/{id}` | **COMPLETED, version 3** |
| `GET …/events` | `WORKFLOW_CREATED → STEP_ISSUED → STEP_SUCCEEDED → WORKFLOW_COMPLETED` with trace ids |
| `/healthz` while healthy | 200, never touches DB |
| `/readyz` with 585 s of unpublished outbox backlog | **503 `relay_lag`** — honest; after rows drained/published: **200 `ready`** |
| `/metrics` | real series moved: `fathom_outbox_unpublished_count`, `fathom_worker_leases_held`, per-(from,reason,to) transition counters, event classification counter |
| unauthenticated `/v1/workflows` | **401** |
| `fathom worker` with empty registry | **refuses to start**, exit 1, message names the reason (no silent no-op worker) |
| `fathom relay` with no brokers | **refuses to start**, exit 1 (no fake sink) |
| `fathom bogus` | mode parse error, exit 1 |
| SIGTERM to the lite stack | bounded LIFO shutdown: http → scheduler → worker → relay lane → store |

The claimed `slow-retry` row at startup was **deliberate residue** of the last
integration package's shutdown test: the live worker executed and honestly
classified it (`no handler registered for task` → Permanent → `FAILED`) — the
unknown-task contract path working in production shape, not a defect.

---

## 7. Defects found and fixed during Phase 5 (caught by the new tests)

These were **real product bugs** surfaced by the tier that first exercised the
path — recorded because "the tests found them" is the honest claim:

1. **JSONB base64 corruption (store).** `jsonb(p.Input)` with a `[]byte` argument
   marshals to a **base64 string**, so stored `input`/`def_snapshot`/`raw` came
   back as `"eyJuIjoxfQ=="`. Caught by `TestAPI_CreateBodyIsDurableRow`/replay
   tests. Fixed with `rawJSONText()` passing untouched JSON text (30+ earlier
   store/worker/relay tests never asserted the wire shape of these columns).
2. **Byte-identity replay broken by JSONB re-rendering.** Stored responses
   changed whitespace/key order on read-back. Fixed by migration-0002 amendment
   (`api_idempotency.response_body` → TEXT; down-path reverses it).
3. **Replay-gate ordering (API).** Consulting the cached response *before*
   `CreateWorkflow` converted the 422 `IDEMPOTENCY_CONFLICT`
   (reused key, different content) into a silent 201 replay. Fixed: the store's
   fingerprint check is the **only** gate; the cache is consulted only after the
   store reports `Replayed`, then re-render + record closes the crash gap.
4. **Aborted-transaction conflict lookup (store).** The business-key conflict
   SELECT ran inside the transaction already aborted by the UNIQUE violation
   (SQLSTATE 25P02) → 500 instead of 409. Fixed with
   `SAVEPOINT wf_insert / ROLLBACK TO SAVEPOINT`.
5. **Middleware order (API).** The rate limiter sat **outside** authentication,
   so it never saw the credential label and limited nothing. Fixed to
   `Authn(limiter(v1))`; `newTestServer` mutate hooks run before assembly so
   tests configure the real chain.

---

## 8. Deliverable map (brief §2–§8 → code → tests)

| Deliverable | Package(s) | Key tests (all green, incl. under `-race`) |
| --- | --- | --- |
| §2 Durable worker claiming | `internal/worker`, store `claim.go` | `TestStore_ClaimMutualExclusionAndRenew`, `TestStore_ClaimRaceSingleWinner`, `TestStore_ExpiredLeaseRequiresReclaim`, `TestStore_StaleVersionRejected`, `TestLoop_WorkerDeathRecovery` |
| §3 Participant contract | `internal/participant`, `internal/worker` | `TestLoop_UnknownTaskFailsLoud`, `TestRetryableFailureThenRetry`, `TestTerminalErrorNeverRetries`, `TestLoop_HappyPath/RetryThenSuccess` |
| §4 Retry/timeout scheduler | `internal/scheduler`, store `scheduler.go` | `TestStore_ScansDriveRetryAndStart`, `TestScheduler_JitterGate`, `TestTimeoutThenRetry`, `TestEscalateDeadline_*`, `TestReclaimLease_*` |
| §5 Compensation + operator | engine recovery edges, store `operator.go`, API | `TestLoop_CompensationExecution`, `TestCompensationFailureEscalates`, `TestResolveManual`, `TestStore_OperatorCancelRecordsAction`, `TestTimeoutWhileCancelling` (gap-1 fix regression) |
| §6 REST API | `internal/api` | 16 integration tests (`TestAPI_*`) + `TestLoopbackOnlyGuard`/`TestParseKeysRules` units — validation, idempotency, concurrency, pagination, RBAC, rate limit, DS-13 mapping |
| §7 Outbox relay | `internal/relay`, `internal/relay/kafka` | `TestRelayLoop_*` (7), `TestStore_RelayClaimAck/CrashRedelivery/RetryExhausted` |
| §8 Observability | `internal/metrics`, `internal/health` | `TestMetrics_SeriesMoveOnRealOperations`, `TestHealthz_NeverTouchesDependencies`, `TestReadyz_GatesOnRealState` |
| §9 wiring + lifecycle | `cmd/fathom`, `internal/config`, `internal/app` | §6 smoke table above; config gate units (`TestAPIKeysRequiredExactlyForHTTPServingModes`, `TestModeMustBeKnown`, `TestPhase5KeyParsing`); carried app lifecycle suite |

---

## 9. Deviations from the normative documents (recorded pre-coding, checklist §2)

1. **One binary with modes** (`control|worker|relay|all`) instead of three
   `cmd/` dirs (roadmap M3.1 sketch) — gap 6; shared module, fewer mains.
2. **Kafka optional at runtime**; relay refuses a fake sink — gap 7.
3. **OTel SDK exporter deferred**; W3C trace *context* is contract-level
   (`traceparent` in every envelope, `trace_id` in logs/problems) — gap 8, no
   fake Jaeger claim.
4. **Bearer-key local-only boundary** with loopback-bind refusal instead of
   cockpit session/CSRF (frontend-phase scope line) — gap 9, ADR-013 amended.
5. **`RETRY_EXHAUSTED` is emitted by the relay** (delivery exhaustion is the
   operator work item), not by the engine's budget paths — gap 5.
6. **`version` required in action request bodies** (cancel/retry/resolve): the
   endpoint table omits it, but optimistic concurrency cannot be honoured
   without the client's observed version; races answer `409 CONFLICT_RETRY`
   carrying the current version.
7. **`POST /v1/workflows/{id}/abandon` not served**: no engine primitive exists
   for "accept current state and stop"; inventing one is out of scope; the
   operator contract (force-terminate / complete-compensation) covers the
   documented manual outcomes.
8. **SSE `/v1/stream` deferred** with the cockpit phase; `audit_event.seq`
   remains the durable resume base.
9. **W15/W16 reading** (cancel wind-down through `COMPENSATING` to the terminal
   outcome set) kept as recorded in checklist gap 2.

---

## 10. Guarantees actually provided (no over-claim)

- **Durable claiming with fencing.** A step is claimed by exactly one live
  worker (`FOR UPDATE SKIP LOCKED` + lease + monotonic attempt); a reclaimed
  worker's late result is refused by the version guard — proven under real
  contention, under `-race`.
- **At-least-once execution** with an explicit participant dedupe contract
  (command key `(workflow_id, step_type, attempt)`); **exactly-once execution
  is NOT claimed anywhere.**
- **Guaranteed progress**: retries are durable + bounded with jitter, deadlines
  escalate (W13), scheduler restarts lose nothing (database clock decides
  due-ness), compensation failure escalates to `FAILED_MANUAL` + durable DLQ.
- **Idempotent API create** on two durable layers: key fingerprint (reuse with
  different content = 422, never a silent replay) + stored-response byte-identical
  replay with `Idempotency-Replayed`; concurrent same-key racers produce exactly
  one workflow.
- **Honest operations surface**: every Prometheus series observed during the
  smoke moved on real operations; `/readyz` failed with `relay_lag` when the
  backlog was genuinely old and recovered when it drained; `/healthz` never
  touches dependencies.
- **Operator actions are audited** (`operator_action` incl. actor label, role,
  reason, state snapshot) and CAS-guarded.

### Known limitations / deferred (scope boundaries)

- `worker` mode ships **no domain participants** (they belong to services); the
  echo handler is an explicitly-labeled dev sample behind `FATHOM_DEV_ECHO`.
- Kafka round-trip was **not** exercised in this phase's gates (no broker in the
  validation set); the relay is proven against the `Publisher` interface + the
  durable bookkeeping; the franz-go client itself was live-proven in Phase 3.
- OTLP trace export, cockpit auth (session/CSRF), SSE, Debezium-mode product
  wiring, frontend: absent by scope, each with a recorded deferral reason.
- GitHub Actions CI has never run (no remote); equivalent gates executed locally.
