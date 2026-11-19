# Fathom — Developer Guide

This guide covers the current Go workflow control plane and the React operations
cockpit. The stack builds on Windows and Linux with **no C toolchain**. The
engine, database-backed API, workers, scheduler, and cockpit are real; the
`echo` task is an explicitly labelled local wiring sample, not business logic.

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
builds still hold (Platform strategy, below). From **Phase 5** the outbox relay
and the Prometheus metrics surface add two further direct, pinned dependencies,
as ADR-005/006 and ADR-015 mandate: `github.com/twmb/franz-go` **v1.22.2** (the
relay's Kafka publisher — pure Go, optional at *runtime*: a relay with no
brokers configured simply does not start) and
`github.com/prometheus/client_golang` **v1.25.0** (`/metrics`). All Phase-5
dependencies are pure Go; `CGO_ENABLED=0` host builds, linux/amd64 and
linux/arm64 cross-compiles were re-proven (see `docs/PHASE_5_VALIDATION_REPORT.md`).
Everything else is the Go standard library. `otel` and `chi` remain probe-only
in the **separate `tools/` module**, and `testcontainers-go` is deliberately
**not** a product dependency; the integration tier runs against a disposable
PostgreSQL container started out-of-band (see `docs/PHASE_4_VALIDATION_REPORT.md`).

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

go run ./cmd/fathom             # lite stack (mode "all"); needs FATHOM_DATABASE_URL + FATHOM_API_KEYS, see §3
go run ./cmd/fathom control     # API + scheduler only
go run ./cmd/fathom worker      # participant execution loop only
go run ./cmd/fathom relay       # outbox→Kafka relay only (needs FATHOM_KAFKA_BROKERS)
```

The Go service requires a reachable PostgreSQL 17+ database. For an end-to-end
local run, set `FATHOM_DATABASE_URL`, `FATHOM_API_KEYS`, and
`FATHOM_DEV_ECHO=1` in the shell, then start `go run ./cmd/fathom`. The example
values in `.env.example` are documentation only: the program does not load a
`.env` file. To open the cockpit in another shell:

```sh
cd web
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`, then present the matching `label:role:key` from
`FATHOM_API_KEYS` in **Settings**. The Vite proxy forwards the cockpit's API
requests to the loopback Go service. `FATHOM_DEV_ECHO=1` enables a deterministic
sample task so a workflow can execute without an external participant service.

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
| `FATHOM_MODE` | yes | `all` | `control` \| `worker` \| `relay` \| `all`; a CLI argument overrides it. |
| `FATHOM_API_KEYS` | yes | — | **required when the mode serves the HTTP API** (`control`/`all`). `label:role:key,…` with role ∈ reader/operator/admin. Treated as a `Secret`; key material never appears in logs or errors. Local-only boundary (loopback bind enforced); see ADR-013. |
| `FATHOM_KAFKA_BROKERS` | yes | — | comma-separated bare `host:port` list (no `PLAINTEXT://` prefix). The relay does not start without it; Kafka remains optional at runtime. |
| `FATHOM_RELAY_ID` / `FATHOM_WORKER_ID` | yes | generated UUIDv7 | durable claim identities for the relay/worker loops. |
| `FATHOM_READY_MAX_OUTBOX_AGE` | yes | `5m` | `/readyz` relay-lag threshold: oldest unpublished outbox row past it ⇒ `503 relay_lag`. |
| `FATHOM_DEV_ECHO` | yes | `false` | registers the deterministic **echo SAMPLE** participant (dev wiring exercises only — explicitly not a domain participant). |
| `FATHOM_RELAY`, `FATHOM_OTLP_ENDPOINT` | **reserved** | — | documented in `.env.example`, not read yet (the OTLP exporter is deferred; trace *context* is contract-level — see PHASE_5_SPEC_CHECKLIST gap 8). |

`.env.example` documents fake local values; it is not loaded by the application.
Set required values in the process environment, and replace every placeholder
before using credentials outside a disposable local database. Never commit a
real `.env` file.

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

Run the Phase-5 lite stack against the local PostgreSQL (add `FATHOM_API_KEYS`
— the API refuses to boot without the bearer boundary — and keep the default
loopback bind):

```sh
FATHOM_DATABASE_URL='postgres://fathom:changeme-local-only@127.0.0.1:5432/fathom?sslmode=disable' FATHOM_API_KEYS='op:operator:changeme-local-only-key' go run ./cmd/fathom
```

It connects and migrates the durable store, then starts exactly what its mode
and configuration honestly support — worker and relay loops skip (with a WARN)
when their prerequisites are absent, and the two dedicated modes **refuse to
start** instead of pretending. `/healthz` never touches the DB; `/readyz`
gates on DB reachability plus relay lag; `/metrics` serves the real-operation
Prometheus surface. `SIGINT`/`SIGTERM` triggers the bounded LIFO graceful
shutdown (API → scheduler → worker → relay → store).

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
cmd/fathom/          ONE binary, mode-selected: `fathom [control|worker|relay|all]` (config -> logger -> store+migrate -> loops/API -> LIFO shutdown)
internal/config/     env-only loading + Secret redaction + Problems errors (modes, API keys, brokers)
internal/logging/    slog JSON logger + key-scrubbing redact handler
internal/id/         UUIDv7 wrapper (depends only on google/uuid, ADR-018)
internal/app/        Component interface + context-aware, bounded graceful shutdown (LIFO)
internal/hygiene/    build-time guards: no committed secrets / formatting regressions
internal/engine/     PURE deterministic state machine — no I/O, no wall clock (SM §2/§3/§5)
internal/store/      postgres: durable transactions, optimistic lock, outbox, dedup,
                     idempotent create (pgx/v5 + golang-migrate, ADR-008/009/011);
                     Phase 5 adds: leased claiming, scheduler scans, relay bookkeeping,
                     DLQ/operator actions, definitions, cursor reads, stored responses
internal/participant/ worker↔engine contract: task registry + RETRYABLE/TERMINAL classification
internal/worker/     durable claim → execute → leased-submit loop (leases, heartbeats, fencing)
internal/scheduler/  retry/timeout reaper loop (durable due-ness via DB clock, bounded jitter)
internal/relay/      pgoutbox relay (claim → publish → ack + checkpoint cursor); kafka/ = franz-go Publisher
internal/api/        REST control plane: problem+json, bearer keys + RBAC, rate limit, cursors
internal/health/     /healthz (never touches deps) + /readyz (DB + relay-lag threshold)
internal/metrics/    Prometheus series wired only to real operations
internal/tracing/    W3C traceparent mint/propagate (contract-level; OTLP exporter deferred)
db/                  embedded versioned migrations 0001+0002 (FS consumed by internal/store/postgres)
tools/               SEPARATE go module (github.com/Lakhyajit-96/fathom/tools) — probe-only deps NOT in product builds:
  portprobe/           blank-import CGO portability matrix (ADR-005 evidence)
  kafkasmoke/          franz-go round-trip verifier used by the CDC smoke (kadm admin ops live here)
deploy/              docker-compose.smoke.yaml + connector JSON + postgres init (smoke only, not a deployment)
scripts/cdc-smoke.sh  the reproducible CDC smoke (shared by dev + CI)
.github/workflows/   ci.yml + cdc-integration.yml (authored; run once a remote exists)
```

`tools/` is a nested module, so the product `go build ./...` / `go test ./...`
never pull the heavy probe dependency graph (franz-go itself entered the
product module in Phase 5 for the relay publisher — ADR-004; `kadm` and
`otel`/`chi` did not). Keep it that way: nothing the product imports at
runtime should move into `tools/`, and nothing in `tools/` should be imported
by `cmd/` or `internal/`.

---

## 8. CI

Two GitHub Actions workflows cover the Go control plane and React cockpit; the
optional CDC workflow exercises the Kafka/Debezium lane. Earlier phase reports
record that these workflows had not run before repository publication. The
current workflow results are authoritative for hosted checks.

- `ci.yml` (PR + push to `main`, ubuntu): Go from `go.mod`, dependency cache,
  then `task fmt:check`, `vet`, `lint`, `test`, `test:race`, `build`,
  `build:linux`, `deps:verify`. The race job only succeeds on Linux.
- `cdc-integration.yml` (PR + push + manual): runs `scripts/cdc-smoke.sh`.

See [`PHASE_8_2_VALIDATION_REPORT.md`](PHASE_8_2_VALIDATION_REPORT.md) for the
latest local verification and the remaining public-hosting gate.

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
