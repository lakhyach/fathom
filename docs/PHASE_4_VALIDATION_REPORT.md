# Phase 4 — Validation Report

**Project:** Fathom (`E:\Projects\fathom-workflow`)
**Scope:** Durable workflow-engine core, PostgreSQL transactions, state-machine proof (Phase 4 brief §11 deliverable).
**Baseline:** Phase 3 commit `f260db8`, on top of Phase 2 `a145d57`. **No remote is configured** (verified: `git remote -v` empty; branch `main`). Phase 2/3 history is preserved; this phase adds one new local commit only.

All results below are **real captured output** from the validation run, not asserted. Every check is marked **PASS / FAIL / BLOCKED / NOT RUN**.

---

## 1. Environment

| Component | Value | Notes |
| --- | --- | --- |
| Dev host OS | Windows 25H2, pwsh | Static/build/cross-compile gates run here natively. |
| Host Go | `go1.26.5 windows/amd64` | Matches `go 1.26.5` in both `go.mod` files. |
| Host gcc | **absent** | `gcc` not recognised → host `go test -race` is BLOCKED-on-host (ADR-004/005). |
| Container engine | Docker Engine 29.x + Compose v5.5 | Used for the disposable PostgreSQL + the native-Linux race run. |
| Native-Linux race toolchain | `golang:1.26.5-bookworm` (`go1.26.5 linux/amd64`, `gcc 12.2.0`) | Digest `sha256:53eeac89…acb4957dd`. Genuine Linux execution — **not** a Windows cross-compile. |
| Durable DB under test | `postgres:17.11-alpine` | `PostgreSQL 17.11 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0`. Published to `127.0.0.1:55432` (host) and reachable as `fathom-int-pg:5432` on the `fathom-int` Docker network. Throwaway; all Phase 4 DSNs use obviously-fake creds and none are committed. |

**Product module dependencies (verified `go.mod`):** 3 pinned direct deps —
`github.com/google/uuid v1.6.0`, `github.com/jackc/pgx/v5 v5.11.0`, `github.com/golang-migrate/migrate/v4 v4.20.1`. `testcontainers-go` is **not** a product dependency (see Deviations §7).

---

## 2. Required validation gates (brief §10)

| # | Gate | Status | Evidence (summary) |
| --- | --- | --- | --- |
| 1 | Formatting (`gofmt -l -s`) | **PASS** | no files listed — `gofmt -s clean` |
| 2 | `go vet ./...` (product) | **PASS** | exit 0 |
| 2b | `go vet ./...` (tools) | **PASS** | exit 0 |
| 3 | Static analysis (`staticcheck v0.8.2`) product | **PASS** | exit 0, no findings |
| 3b | Static analysis (tools) | **PASS** | exit 0, no findings |
| 4 | All unit tests (`go test ./...`, no tag) | **PASS** | 47 PASS / 0 FAIL across 7 packages |
| 5 | Race-enabled tests on supported Linux | **PASS** | native `linux/amd64` `go test -race ./...` (all pkgs) + `-tags integration` 18 PASS, no race reports |
| 6 | CGO-disabled build | **PASS** | `CGO_ENABLED=0 go build ./...` product+tools exit 0 |
| 6b | Cross-compile `linux/amd64` | **PASS** | product+tools exit 0 |
| 6c | Cross-compile `linux/arm64` | **PASS** | product+tools exit 0 |
| 7 | Fresh PostgreSQL migration | **PASS** | clean schema → migrate v1, not dirty; re-migrate no-op |
| 8 | All PostgreSQL integration tests | **PASS** | 18 PASS (3 idempotency unit + 15 T-INT) |
| 9 | Repeatable idempotency + concurrency | **PASS** | concurrent-create=1, concurrent-writer=1-commit; re-run + race clean |
| 10 | Secret / hygiene checks | **PASS** | `internal/hygiene` ok; manual scan: no creds in Phase 4 files |
| 11 | `git diff --check` | **PASS** | exit 0, no whitespace/conflict markers |
| 12 | Review of all changed + untracked files | **PASS** | full-diff review (this report §9) |
| — | GitHub Actions CI run (`ci.yml`, `cdc-integration.yml`) | **NOT RUN** | repo has no remote; workflows cannot execute on a GitHub-hosted runner. Reported honestly per §10. Locally reproduced the full `ci` gate set instead. |

---

## 3. Raw command output — static + build gates (Windows host)

```
### GOFMT (product+tools) ###
gofmt -s clean (no files listed)
### GO VET product ###
vet product exit=0
### GO VET tools ###
vet tools exit=0

### STATICCHECK product ###
sc product exit=0
### STATICCHECK tools ###
sc tools exit=0

### UNIT TESTS (no integration tag) ###
?   	github.com/Lakhyajit-96/fathom/cmd/fathom       	[no test files]
?   	github.com/Lakhyajit-96/fathom/db               	[no test files]
ok  	github.com/Lakhyajit-96/fathom/internal/app             	4.751s
ok  	github.com/Lakhyajit-96/fathom/internal/config          	4.569s
ok  	github.com/Lakhyajit-96/fathom/internal/engine          	4.309s
ok  	github.com/Lakhyajit-96/fathom/internal/hygiene         	4.350s
ok  	github.com/Lakhyajit-96/fathom/internal/id              	4.320s
ok  	github.com/Lakhyajit-96/fathom/internal/logging         	4.718s
ok  	github.com/Lakhyajit-96/fathom/internal/store/postgres  	4.535s
unit exit=0
TOTAL unit PASS=47 FAIL=0

### CGO=0 host build (product) ###   product exit=0
### CGO=0 host build (tools)  ###    tools exit=0
### linux/amd64 product ###          linux/amd64 product exit=0
### linux/arm64 product ###          linux/arm64 product exit=0
### linux/amd64 tools   ###          linux/amd64 tools exit=0
### linux/arm64 tools   ###          linux/arm64 tools exit=0

### go mod verify (product) ###      all modules verified   (exit=0)
### go mod tidy -diff (product) ###  (empty)                 (exit=0)
### go mod verify (tools)     ###    all modules verified   (exit=0)
### tools go mod tidy -diff ###      (empty)                 (exit=0)
### git diff --check ###             (clean)                 (exit=0)
### hygiene test suite ###           ok .../internal/hygiene  (exit=0)
```

---

## 4. Race — native Linux execution (`golang:1.26.5-bookworm`)

> The host has no gcc, so `go test -race` cannot run on Windows. To satisfy §10 **genuinely**, the suite was executed inside a real Linux container (`go1.26.5 linux/amd64` + gcc 12.2.0). This is native-Linux test execution, **not** a Windows cross-compile presented as such.

**4a. All packages, untagged (`-race`, CGO on):**

```
go version go1.26.5 linux/amd64
gcc (Debian 12.2.0-14+deb12u1) 12.2.0
ok   github.com/Lakhyajit-96/fathom/internal/app              1.120s
ok   github.com/Lakhyajit-96/fathom/internal/config           1.020s
ok   github.com/Lakhyajit-96/fathom/internal/engine           1.148s
ok   github.com/Lakhyajit-96/fathom/internal/hygiene          1.451s
ok   github.com/Lakhyajit-96/fathom/internal/id               1.043s
ok   github.com/Lakhyajit-96/fathom/internal/logging          1.013s
ok   github.com/Lakhyajit-96/fathom/internal/store/postgres   1.018s
```

**4b. Integration tier, `-race`, against live PostgreSQL 17.11** (Go container attached to the `fathom-int` Docker network so it reaches the DB by name). The two concurrency tests run under the race detector with **zero data-race reports**:

```
--- PASS: TestStore_ConcurrentWritersSameVersion          (0.03s)
--- PASS: TestStore_ConcurrentCreateSameIdempotencyKey    (0.04s)
PASS
ok   github.com/Lakhyajit-96/fathom/internal/store/postgres  1.609s
```

Command (reproducible):

```
docker run --rm --network fathom-int \
  -v E:\Projects\fathom-workflow:/src -v fathom-gomod:/go/pkg/mod -w /src \
  -e CGO_ENABLED=1 \
  -e FATHOM_TEST_DATABASE_URL=postgres://fathom:changeme-integration-only@fathom-int-pg:5432/fathom?sslmode=disable \
  golang:1.26.5-bookworm sh -c "go test -race -count=1 -tags integration ./internal/store/..."
```

---

## 5. PostgreSQL — fresh migration + full integration suite

Schema dropped to empty before the run (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`) to prove a **from-nothing** apply via the embedded, versioned migration consumed by `internal/store/postgres`.

```
PostgreSQL 17.11 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0
DROP SCHEMA / CREATE SCHEMA / GRANT  (reset exit=0)

--- PASS: TestCanonicalJSON_StableAcrossKeyOrder                (idempotency unit)
--- PASS: TestCanonicalJSON_EmptyIsCanonicalNull                (idempotency unit)
--- PASS: TestHashCreateRequest_OrderInsensitiveAndValueSensitive (idempotency unit)
--- PASS: TestStore_MigrateFreshAndVersion                      (fresh schema -> v1, not dirty; re-migrate no-op)
--- PASS: TestStore_CreateIsAtomic                              (workflow+2 steps+audit+outbox in one tx)
--- PASS: TestStore_TransitionAtomicity_CommitTogether          (state+step+dedup+outbox commit together)
--- PASS: TestStore_ConcurrentWritersSameVersion                (at most one commits, ADR-009)
--- PASS: TestStore_ConcurrentCreateSameIdempotencyKey          (exactly one workflow, 6 racing callers)
--- PASS: TestStore_IdempotencyKeyReuseDifferentPayload         (typed conflict on fingerprint mismatch; replay stable)
--- PASS: TestStore_DedupRepeatedDelivery                       (byte-identical redelivery = DUPLICATE, no state change)
--- PASS: TestStore_RollbackOnMidwayFailure                     (whole tx rolls back; no partial write)
--- PASS: TestStore_ProcessRestart                              (reload persisted state; no in-memory cache)
--- PASS: TestStore_AppendOnlyAuditTrigger                      (UPDATE/DELETE on audit_event + processed_events refused)
--- PASS: TestStore_SchemaConstraints                           (FK/unique/CHECK invariants enforced)
--- PASS: TestStore_DS1Regression_TerminalNotReopened           (replayed/stale event cannot downgrade a terminal wf)
--- PASS: TestStore_CompensationFailureEscalates                (W12 -> FAILED_MANUAL + dead_letter row)
--- PASS: TestStore_NotFoundIsNotSilent                         (absent row -> NotFoundError, not a masked fault)
--- PASS: TestStore_MigrateDownRoundTrip                        (down -> version 0, all durable tables gone; re-up -> v1 live)
PASS
ok   github.com/Lakhyajit-96/fathom/internal/store/postgres  6.144s   (18 PASS)
```

**Down-migration / rollback proof** (`TestStore_MigrateDownRoundTrip`): reverses `0001` via the embedded `.down.sql`, asserts migrate version returns to nil and every durable table is gone, then re-applies up and drives a full workflow to `COMPLETED` on the recreated schema. Rollback is **only** exercised against a throwaway DB; the brief (§4) forbids promising a data-loss-free down in production, and this phase makes no such promise.

---

## 6. Test inventory

| Tier | Package / file | New in Phase 4 | Purpose |
| --- | --- | --- | --- |
| Pure state machine | `internal/engine` (`machine_test.go`, `invariant_test.go`, `regression_test.go`) | 13 | Legal/illegal transitions, terminal immutability, classification order, stale version, retry vs permanent, compensation order, compensation-failure escalation, timeout, cancel edges, AT-12 invariant sweep, DS-1 regression. |
| Idempotency (pure) | `internal/store/postgres/idempotency_test.go` | 3 | Canonical-JSON stability across key order/whitespace; numeric literal preservation; order-insensitive + value-sensitive SHA-256 fingerprint. |
| PostgreSQL T-INT | `internal/store/postgres/integration_test.go` | 15 | Fresh+down migration, atomic create, transition atomicity, concurrency, idempotency, dedup, rollback, restart, append-only triggers, schema constraints, DS-1, compensation escalation, not-found. |
| **Repo-wide untagged** | `go test ./...` | 47 PASS / 0 FAIL | All existing Phase 3 foundation tests remain green alongside the new engine + store unit tests. |

---

## 7. Deviations from the normative documents (recorded before coding, per brief §1)

Carried from `docs/PHASE_4_SPEC_CHECKLIST.md` §3; each is an honest, minimal resolution:

1. **Migration embed location.** The `db` package is the single home of the embedded migrations; the store consumes `db.Migrations` (the store's own duplicate `//go:embed` was removed). Resolves a build-breaking embed that matched nothing.
2. **`dead_letter` table.** The engine emits `EffectDeadLetter` on W12 (compensation failure); persisting it is mandatory ("never silently discard an error"), and it is a normative DATA §A.4 table. `dead_letter` was added to migration 0001 and is inserted inside the W12 transaction. DLQ *replay/resolution* (operator W17/W18) stays out of scope.
3. **Dependency count.** `DEVELOPMENT.md` §1 and ADR-004 said the product module had "exactly one external dependency." That was Phase-3 foundation-scoped. ADR-008 mandates pgx + golang-migrate for the durable store; both were added to the **product** `go.mod` (pinned v5.11.0 / v4.20.1) and the docs were amended with a Phase-4 note. `CGO_ENABLED=0` and cross-compilation still hold (pure-Go deps).
4. **`testcontainers-go` deliberately excluded from the product module.** It would balloon the product dependency graph even though it sits behind a build tag. Instead the T-INT tier is gated by `//go:build integration` + `FATHOM_TEST_DATABASE_URL`, `t.Skip`s when unset (so `go test ./...` stays DB-free), and runs against an out-of-band disposable container.
5. **Column invariants the machine does not model** (`started_at`, `finished_at`, `terminal_coherence` CHECK). The store derives them inside the transaction from the returned snapshot; the machine stays time/transport-free.
6. **`ResultEvent.ExpectedVersion` dual enforcement.** The machine rejects a version mismatch (`StaleVersionError`) *and* the SQL UPDATE is guarded on the loaded version — belt-and-braces per SM §2.

---

## 8. Guarantees actually provided (no over-claim, brief §3/§9)

- **Durable state transitions.** Every APPLIED transition commits workflow state, version bump, step rows, the dedup ledger row, audit history, and outbox intent **in one transaction**; a mid-way failure rolls the whole thing back (proven).
- **Idempotent processing where explicitly enforced:**
  - create — `api_idempotency` key + canonical SHA-256 request fingerprint: a matching replay returns the same durable outcome, a reused key with a different fingerprint is a typed `IdempotencyConflictError`, and concurrent racers produce exactly one workflow;
  - inbound events — `processed_events` dedup ledger keyed on `event_id`: a byte-identical redelivery is classified `DUPLICATE` with zero state effect.
- **Optimistic concurrency.** `WHERE id=$1 AND version=$2 AND state NOT IN (terminal)`; `RowsAffected != 1` surfaces as a typed `ConflictError` — never a silent overwrite (closes DS-4). Proven under real concurrent writers, with and without `-race`.
- **Terminal immutability (DS-1).** Terminal states have no outbound transition edge and the SQL wall refuses to touch a terminal row; a stale/replayed event can never reopen or downgrade a completed workflow. Proven by the DS-1 regression at both the machine and PostgreSQL layers.
- **Transactional outbox.** Command intents are written in the same transaction as the state change and carry an explicit `aggregate_id` (ADR-007/010 honoured); the relay that moves them to Kafka is a later phase and is **not** implemented or claimed here.

**What is NOT claimed:** exactly-once execution. The correct statement is *durable transitions + idempotent processing where enforced + at-least-once delivery* for the (future) relay. At most one `APPLIED` transition per `(workflow, step, attempt, expected-version)` mutates state; every non-`APPLIED` classification has zero state effect.

### Known limitations / deferred (scope boundaries, brief §2)

- Kafka/Debezium production relay workers, HTTP API/auth, React cockpit, billing, Kubernetes — out of scope, not built.
- The **reaper/scheduler loop** that decides to call `Retry`/`TimeoutStep`, and the **worker step-claim** path (`SELECT … FOR UPDATE SKIP LOCKED` + `lease_expires_at`, ADR-009 second half) are intentionally **not** implemented this phase; only the pure transitions and their durable persistence are.
- GitHub Actions CI has **never run** (no remote); the equivalent gate set was executed locally instead.

---

## 9. Full-diff review (files in this commit)

| File | Kind | Notes |
| --- | --- | --- |
| `go.mod`, `go.sum` | modified | +`pgx/v5 v5.11.0`, +`golang-migrate/v4 v4.20.1`; `go mod verify`/`tidy -diff` clean. |
| `db/db.go`, `db/migrations/0001_durable_core.{up,down}.sql` | new | Embedded migration FS; durable-core schema (workflow/step/attempt/inbound_event/processed_events/outbox/api_idempotency/dead_letter/audit_event) + append-only triggers. |
| `internal/engine/{engine,machine,errors}.go` | new | Pure deterministic state machine + typed errors. |
| `internal/engine/{machine,invariant,regression}_test.go` | new | 13 pure state-machine/invariant/regression tests. |
| `internal/store/postgres/{store,workflow,idempotency,errors}.go` | new | Durable transactional store: create, apply, guarded transitions, outbox, dedup, idempotency, typed errors. |
| `internal/store/postgres/{idempotency,integration}_test.go` | new | 3 idempotency unit + 15 PostgreSQL T-INT tests. |
| `docs/PHASE_4_SPEC_CHECKLIST.md` | new | §1 checklist: change→spec/ADR map + contradictions/resolutions. |
| `docs/PHASE_4_VALIDATION_REPORT.md` | new | This report. |
| `docs/DEVELOPMENT.md` | modified | Phase-4 dependency note; layout + race-path corrections. |
| `docs/ARCHITECTURE_DECISIONS.md` | modified | ADR-004 Phase-4 update (dependency count superseded). |

`git diff --check`: **clean (0 warnings) across the whole commit**. Every Phase 4 file is written as **UTF-8 without BOM with LF** endings, per the project's own `.editorconfig` (`end_of_line = lf`, `trim_trailing_whitespace = true`, `root = true`). This is why the two pre-existing Markdown files show a large diff: they were stored CRLF *in violation of* `.editorconfig`; Phase 4 corrects the files it touches to LF alongside their content edits (`.go` files were already LF via `gofmt`). No repo-wide reformat is attempted — only files this phase edits. Manual secret scan of all Phase 4 files: no credentials (the only DSNs are obviously-fake throwaway values supplied via environment, never committed).

---

## 10. Commit & stopping

- One new local commit on `main` (no amend of Phase 2/3), no remote, nothing pushed, nothing deployed.
- Commit hash is recorded in the final chat report.
- **Phase 4 stops here.** Phase 5 (HTTP API / relay workers / frontend) is **not** started; proceeding requires explicit authorization.

### Are the durable-engine invariants proven?

Yes for the scope implemented: durable transitions, optimistic-concurrency conflict, create idempotency, event dedup, terminal immutability, atomic outbox/audit/dedup commitment, and full transaction rollback are each backed by at least one **real** PostgreSQL test, and the concurrency tests additionally pass under a native-Linux race detector. The deferred reaper/claim loop and any exactly-once claim remain explicitly out of scope and are not represented as done.
