# Fathom — Developer Guide

This is the **reproducible engineering foundation** only (Phase 3). It is not a
workflow engine, an API, a deployment, or a product — those come in later
phases. Everything here is chosen so a clean checkout builds, tests, and runs
on Windows and Linux with **no C toolchain** and **no ambiguity about versions**.

> Scope guard: the only product code is a minimal, compilable entry point plus
> the foundation packages (config, logging, id, app lifecycle, repo hygiene).
> No business/workflow behaviour is implemented or faked here.

---

## 1. Toolchain (pinned — do not float)

| Tool | Pinned version | Why / how to get it |
| --- | --- | --- |
| Go | **1.26.5** | Declared as `go 1.26.5` in both `go.mod` files; CI reads it via `go-version-file`. Install from go.dev. |
| go-task | **v3.54.0** | The cross-platform command runner. `go install github.com/go-task/task/v3/cmd/task@v3.54.0` |
| staticcheck | **v0.8.2** | Linter, run via `go run honnef.co/go/tools/cmd/staticcheck@v0.8.2` (see `task lint`) — no separate install needed. |
| Docker Engine + Compose v2 | Engine 29.x, Compose v5.5+ | Only needed for the optional CDC smoke test (§6). |

In the Phase-3 foundation the product module had exactly **one** direct
dependency: `github.com/google/uuid` (ADR-018). From **Phase 4** the durable
PostgreSQL store adds two direct, pinned dependencies to the product module, as
ADR-008 mandates: `github.com/jackc/pgx/v5` **v5.11.0** (pool + the `stdlib`
driver the migrator wraps) and `github.com/golang-migrate/migrate/v4` **v4.20.1**
(embedded, versioned migrations). Both are pure Go, so `CGO_ENABLED=0` product
builds still hold (Platform strategy, below). Everything else is the Go standard library, and the
remaining heavier graph (franz-go, otel, prometheus, chi, testcontainers) still
lives in the **separate `tools/` module** so it never enters product builds —
see §7. `testcontainers-go` is deliberately **not** a product dependency; the
integration tier runs against a disposable PostgreSQL container started
out-of-band (see `docs/PHASE_4_VALIDATION_REPORT.md`).

### Platform strategy
- Development and ordinary CI build/test with **`CGO_ENABLED=0`** (ADR-004/005).
  The whole product stack is pure Go, so it builds on Windows without gcc and
  cross-compiles for Linux cleanly.
- Supported targets: `windows/amd64` (dev host), `linux/amd64`, `linux/arm64`.
- `go test -race` **requires cgo/gcc** and therefore cannot run on the Windows
  dev host directly (it reports `go: -race requires cgo` — a documented
  BLOCKED-on-host case, not a failure). It runs on native Linux: on CI, and
  locally via a Linux container (Phase 4 validated with `golang:1.26.5-bookworm`,
  which ships gcc). A Windows cross-compile is **not** a substitute for this —
  see `docs/PHASE_4_VALIDATION_REPORT.md` §Race.

---

## 2. Quick start

```sh
go version                      # expect go1.26.5
go install github.com/go-task/task/v3/cmd/task@v3.54.0

task --list                     # enumerate the command surface
task ci                         # the exact PR gate set (fmt, vet, lint, test, build)

go run ./cmd/fathom             # runs the minimal entry point (needs FATHOM_DATABASE_URL, see §3)
```

`task` resolves `sh` on Git-for-Windows and on Linux alike, so the same
Taskfile is the single source of truth on both. Nothing here requires `make`.

---

## 3. Configuration

Configuration comes **only from environment variables** (`internal/config`).
There is no config file, and **no secret is ever committed or embedded**.

| Key | Read now? | Default | Notes |
| --- | --- | --- | --- |
| `FATHOM_ENV` | yes | `dev` | `dev` \| `prod` |
| `FATHOM_LOG_LEVEL` | yes | `info` | `debug` \| `info` \| `warn` \| `error` |
| `FATHOM_HTTP_ADDR` | yes | `127.0.0.1:8080` | loopback by default (security baseline) |
| `FATHOM_SHUTDOWN_TIMEOUT` | yes | `10s` | graceful-shutdown budget |
| `FATHOM_DATABASE_URL` | yes | — | **required**; a `postgres://` URL. Treated as a `Secret`. |
| `FATHOM_RELAY`, `FATHOM_KAFKA_BROKERS`, `FATHOM_OTLP_ENDPOINT` | **reserved** | — | documented in `.env.example`, not read by the foundation yet. |

Safe local setup:

```sh
cp .env.example .env      # .env is git-ignored; every value in the example is fake
```

Secret-handling guarantees (all covered by tests in `internal/config` and
`internal/logging`):
- `Secret.String()/GoString()/MarshalJSON` are redacted, so `%v/%s/%#v`/JSON of a
  config never reveal the DSN.
- Validation errors are a typed `Problems` list that names the offending **key**
  and the nature of the fault, never the value.
- The logger wraps the JSON handler in a key-scrubbing `redactHandler`, so an
  attribute named `password`, `token`, `dsn`, `database_url`, … is masked at
  log time even if a caller passes it by mistake.
- `FATHOM_KAFKA_BROKERS` takes a bare `host:port` — never a `PLAINTEXT://`
  scheme prefix (that is a broker concept and a client parse error; Phase 1 DS-10).

Run with a placeholder DSN (the foundation does not connect to the DB yet):

```sh
FATHOM_DATABASE_URL='postgres://fathom:changeme-local-only@127.0.0.1:5432/fathom?sslmode=disable' go run ./cmd/fathom
```

It logs structured startup, then waits for `SIGINT`/`SIGTERM` and performs a
bounded graceful shutdown before exiting (there are no components to stop yet,
so it exits promptly).

---

## 4. Commands (Taskfile)

Run `task --list` for the current set. The documented surface mirrors raw
`go`/`gofmt` commands, so you can always do anything without Task.

| Task | Purpose | Raw equivalent |
| --- | --- | --- |
| `task fmt` | Format in place | `gofmt -w -s .` |
| `task fmt:check` | Fail if anything is not `gofmt -s` clean | `gofmt -l -s .` (empty output) |
| `task vet` | `go vet` both modules | `go vet ./...` ; `cd tools && go vet ./...` |
| `task lint` | staticcheck v0.8.2, both modules | `go run honnef.co/go/tools/cmd/staticcheck@v0.8.2 ./...` |
| `task test` | Unit tests (no broker/DB) | `go test ./...` |
| `task test:race` | Race tests (**Linux only**; needs cgo) | `CGO_ENABLED=1 go test -race ./...` |
| `task build` | CGO-disabled host build, both modules | `CGO_ENABLED=0 go build ./...` |
| `task build:linux` | Cross-compile linux/amd64 + arm64 | `GOOS=linux GOARCH=amd64 go build ./...` (etc.) |
| `task deps:verify` | `go mod verify` + `go mod tidy -diff` (no drift) | same |
| `task hygiene` | Repo secret/format guards | `go test ./internal/hygiene/...` |
| `task cdc:smoke` | Kafka/Debezium image-pair smoke (needs Docker) | `./scripts/cdc-smoke.sh` |
| `task ci` | The exact PR gate set | fmt:check + vet + lint + test + build + tidy-diff |

The `sh`-style env prefix syntax (`GOOS=linux …`, `CGO_ENABLED=1 …`) used inside
the Taskfile is executed by Task via `sh`, so it works identically on Windows
(Git bash) and Linux.

---

## 5. Testing

The foundation tests are deterministic and need **no Kafka broker and no
database**. Current product suites (`go test ./...`):

- `internal/config` — defaults, overrides, invalid values, required-key errors
  (that name keys, never values), and redaction across `%v/%s/%#v`/JSON.
- `internal/logging` — redaction at log time (case-insensitive, nested groups,
  `WithAttrs`), level filtering, unknown-level rejection, valid-JSON output.
- `internal/id` — UUIDv7 canonical shape, uniqueness, strict in-process
  monotonic ordering, deterministic-from-entropy, reject-garbage.
- `internal/app` — run returns on context cancel, LIFO component shutdown, error
  propagation, bounded shutdown, nil-logger rejection.
- `internal/hygiene` — fails the build if a banned secret file (`/.env`,
  `*.pem`, `*.key`, …) or an embedded secret literal (outside an obviously-fake
  allowlist) is ever added.

Infrastructure integration tests (Kafka/Debezium) are **separate** and live in
the CDC smoke (§6), not in `go test ./...`.

---

## 6. Optional: CDC / Kafka smoke test

`task cdc:smoke` (or `./scripts/cdc-smoke.sh`) proves the pinned image pair
actually works with the franz-go client and the Debezium Outbox EventRouter,
using obviously-fake credentials and loopback-only ports. It:

1. starts `apache/kafka:4.3.1` + `quay.io/debezium/connect:3.7.0.Final` +
   `postgres:17.11-alpine` (`--wait`, all healthy);
2. runs a franz-go round-trip (create topic → produce 8 → consume+verify →
   commit) against the broker;
3. waits for the Connect REST API, registers the outbox connector, waits for
   connector **and** task `RUNNING`;
4. inserts an outbox row and confirms it is routed to the `smoke.events` topic
   with the expected key/headers/payload;
5. tears everything down (`down -v`) via an exit trap.

It needs Docker + Compose v2 + `curl`. The same script is the CI integration
job, so CI cannot drift from these docs.

---

## 7. Repository layout

```
cmd/fathom/          minimal, compilable entry point (signal ctx -> config -> logger -> app.Run)
internal/config/     env-only loading + Secret redaction + Problems errors
internal/logging/    slog JSON logger + key-scrubbing redact handler
internal/id/         UUIDv7 wrapper (depends only on google/uuid, ADR-018)
internal/app/        Component interface + context-aware, bounded graceful shutdown
internal/hygiene/    build-time guards: no committed secrets / formatting regressions
internal/engine/     PURE deterministic state machine — no I/O, no wall clock (SM §2/§3/§5)
internal/store/      postgres: durable transactions, optimistic lock, outbox, dedup,
                     idempotent create (pgx/v5 + golang-migrate, ADR-008/009/011)
db/                  embedded versioned migrations (FS consumed by internal/store/postgres)
tools/               SEPARATE go module (github.com/Lakhyajit-96/fathom/tools) — NOT product deps:
  portprobe/           blank-import CGO portability matrix (ADR-005 evidence)
  kafkasmoke/          franz-go round-trip verifier used by the CDC smoke
deploy/              docker-compose.smoke.yaml + connector JSON + postgres init (smoke only, not a deployment)
scripts/cdc-smoke.sh  the reproducible CDC smoke (shared by dev + CI)
.github/workflows/   ci.yml + cdc-integration.yml (authored; run once a remote exists)
```

`tools/` is a nested module, so the product `go build ./...` / `go test ./...`
never pull the heavy probe dependency graph. Keep it that way: nothing the
product imports at runtime should move into `tools/`, and nothing in `tools/`
should be imported by `cmd/` or `internal/`.

---

## 8. CI

Two GitHub Actions workflows are committed but have **never run** — this repo
has no remote yet (ADR-001). They were validated for syntax with `actionlint`.

- `ci.yml` (PR + push to `main`, ubuntu): Go from `go.mod`, dependency cache,
  then `task fmt:check`, `vet`, `lint`, `test`, `test:race`, `build`,
  `build:linux`, `deps:verify`. The race job only succeeds on Linux.
- `cdc-integration.yml` (PR + push + manual): runs `scripts/cdc-smoke.sh`.

Once a remote exists (a later, user-authorized step), these become the merge
gate. See `docs/PHASE_3_VALIDATION_REPORT.md` for what has and has not actually
executed.

---

## 9. Troubleshooting

- **`go: -race requires cgo` on Windows** — expected. `task test:race` is a
  Linux-CI target; run `task test` locally instead.
- **CDC smoke: `connector register` returns empty / fails once, then works** —
  Kafka Connect is still initialising after `up --wait`. The script now polls
  `GET /connectors` for `200` first; if you bypass the script, wait for that.
- **CDC smoke under Git-bash: `C:/Program Files/Git/opt/kafka/...: no such file`** —
  MSYS path rewriting of in-container paths. The script exports
  `MSYS_NO_PATHCONV=1`; run it *through* the script, not by copy-pasting the
  `docker compose exec … /opt/…` lines into pwsh.
- **Debezium task `FAILED`: `"aggregateid is not a valid field name"`** — the
  Outbox EventRouter defaults the event-key column to `aggregateid`; with snake_case
  `aggregate_id` you must set `transforms.outbox.table.field.event.key`. (ADR-007)
- **Debezium task `FAILED`: `"Field 'created_on' is not of type INT64"`** — the
  event-timestamp mapping needs an epoch INT64 column, not `TIMESTAMPTZ`; omit the
  mapping or store epoch-millis BIGINT. (ADR-007)
- **`task` not found after `go install`** — `$(go env GOPATH)/bin` isn't on PATH.
  Add it, or invoke the binary by full path.
- **PowerShell mangles inline `VAR=val cmd` or `%{http_code}`** — those forms are
  sh-isms; run them through `task`/Git-bash, not inline in pwsh.
