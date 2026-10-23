# Phase 4 — Specification Compliance Checklist

Purpose (Phase 4 brief §1): map every Phase-4 change to the normative spec and
relevant ADRs **before** writing code, and record contradictions + their
resolution. Sources: `WORKFLOW_STATE_MACHINE.md`, `DATA_AND_API_CONTRACTS.md`,
`ARCHITECTURE_DECISIONS.md` (ADRs), `RELIABILITY_AND_FAILURE_TEST_PLAN.md`,
`DEVELOPMENT.md`, `PHASE_3_VALIDATION_REPORT.md`.

## 1. Change → spec/ADR map

| Phase-4 deliverable | Normative anchor | Where realised |
| --- | --- | --- |
| Pure workflow + step + compensation state machine | SM §2/§3/§5, §9 | `internal/engine/{engine,machine,errors}.go` |
| Terminal immutability (REQ-C-1, DS-1 closure) | SM §2 ★, §5 `TERMINAL_IGNORED` | `machine.go` `ApplyResult`; `regression_test.go`; `invariant_test.go` (AT-12) |
| Optimistic concurrency in the machine | SM §2 guards, ADR-009 | `machine.go` `guard()` → `StaleVersionError` |
| Duplicate/stale/unsolicited classification | SM §5, DATA §A.2 | `machine.go` classification order |
| Deterministic compensation order (reverse over completed) | SM §1, §2 W7/W10/W11 | `machine.go` `completedCompensable`/`nextCompensating` |
| Retry vs permanent-failure decision | SM §2 W5/W6/W7/W8, §8 backoff | `machine.go` `applyForwardResult`, `Retry`, `backoff` |
| Compensation failure → FAILED_MANUAL + DLQ | SM W12, DATA §A.4 | `machine.go` `applyCompensationResult`; store `dead_letter` insert |
| PostgreSQL schema + versioned migration | DATA §A, ADR-008 | `db/migrations/0001_durable_core.{up,down}.sql` |
| Transactional create (state+audit+outbox in one tx) | SM W1, DATA §A.2/§6 | `internal/store/postgres/workflow.go` |
| Optimistic-lock UPDATE predicate | DATA §A.1 transition guard, ADR-009 | `workflow.go` `commitTransition` (guarded UPDATE + terminal wall) |
| Durable idempotency (create) | DATA §A.3/§D, ADR-011 | `workflow.go` `CreateWorkflow`, `idempotency.go` |
| Transactional outbox + aggregate_id key | DATA §A.2, SM §6, ADR-007 | `workflow.go` `writeOutbox` |
| Consumer-dedup ledger | DATA §A.2 `processed_events`, ADR-011 | `workflow.go` dedup insert |
| Inbound-event visibility (store-before-classify) | SM §5 | `workflow.go` `ApplyResult` |
| Integration tests | Test plan §1 T-INT, brief §8 | `internal/store/postgres/*_test.go` |

## 2. Scope guards honoured

No Kafka/Debezium relay workers, no HTTP API/auth, no React cockpit, no billing,
no Kubernetes. `pgoutbox` stays the default pure-Go design (ADR-006); CDC config
(ADR-007) is untouched by this phase. The reaper scheduler (W6/W13 driver) is
**not** implemented here — only the pure transitions (`Retry`, `TimeoutStep`)
and their durable persistence are; the loop that decides to call them is a later
phase (stated in `machine.go` doc comments).

## 3. Contradictions found and resolution (recorded before coding)

1. **`store.go` embeds `migrations/*.sql` from its own package dir, but the SQL
   lives in `db/migrations/`.** Build-breaking (embed pattern matches nothing).
   Resolution: the `db` package is the single home of the embedded migrations;
   the store uses `db.Migrations` and its own `//go:embed` directive is removed.
   One source of truth, no duplicated `embed.FS`.

2. **The migration header comment says `dead_letter` is out of this phase's
   storage contract, yet the committed engine emits `EffectDeadLetter` on W12
   (compensation failure), and DATA §A.4 + SM §7 norm the table.** Persisting
   the engine's effect is mandatory ("never silently discard an error", brief
   §3.9), and `dead_letter` is a normative §A.4 table.
   Resolution: add the minimal `dead_letter` table (columns per §A.4 subset this
   phase writes) to migration 0001 and have the store insert it inside the W12
   transaction. The migration comment is corrected. DLQ *resolution/replay*
   (operator actions, W17/W18) stays out of scope — only the durable insert is.

3. **`DEVELOPMENT.md` §1 and ADR-004 claim the product module has exactly ONE
   external dependency (`google/uuid`), with pgx living only in `tools/`.**
   Phase 4's durable store genuinely needs `pgx/v5` + `golang-migrate/v4` in the
   **product** module, which ADR-008 already mandates ("Client pgx v5.11.0 …
   schema via golang-migrate"). The "one dependency" line was a Phase-3
   foundation-scoped statement, not a permanent rule.
   Resolution: add the two ADR-008-pinned modules to the product `go.mod`
   (pinned v5.11.0 / v4.20.1), and amend `DEVELOPMENT.md` §1 + ADR-004 with a
   Phase-4 note. `testcontainers-go` is deliberately **not** added to the product
   module (see #4).

4. **Test plan §1 names `testcontainers-go` for the T-INT tier, but brief §8
   allows "an isolated test database **or** disposable test container".** Adding
   testcontainers to the product `go.mod` (it is scanned by `go mod tidy` even
   behind a build tag) would balloon the product dependency graph the ADRs work
   to keep small.
   Resolution: integration tests are gated behind the `integration` build tag and
   read `FATHOM_TEST_DATABASE_URL`; they are run against a disposable
   `postgres:17.11-alpine` container (ADR-007/008 pin) started out-of-band by the
   validation script, not by a Go dependency. Tests `t.Skip` cleanly when the env
   var is unset, so `go test ./...` stays DB-free (DEVELOPMENT §5). Documented as
   a deviation in the validation report.

5. **Workflow row CHECK `terminal_coherence` (terminal ⇔ `finished_at` NOT NULL)
   and `started_at`** are column invariants the pure machine does not model (it
   only returns a `WorkflowState`). Resolution: the store derives `started_at`
   (first entry to RUNNING) and `finished_at` (entry to a terminal state, cleared
   otherwise) from the returned snapshot inside the transaction, so the DB
   constraint is always satisfied. The machine stays transport/time-free.

6. **`ResultEvent.ExpectedVersion` semantics**: the reader's observed version,
   used for stale detection *and* mirrored by the SQL guard. Resolution: store
   loads the current row under `FOR UPDATE`, feeds it to the machine (which
   rejects a mismatch with `StaleVersionError`), and issues the UPDATE guarded on
   the loaded version — dual enforcement per SM §2 (belt-and-braces).

## 4. Guarantees actually claimed (no over-claim, brief §3/§9)

Durable state transitions + idempotent processing where enforced (create
idempotency, `processed_events` dedup) + at-least-once outbox. **Not** claiming
exactly-once execution — the engine guarantees at most one `APPLIED` transition
per `(step, attempt)` mutates state; a non-APPLIED classification has zero state
effect. Stated verbatim in the package docs and the validation report.
