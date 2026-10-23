# Phase 3 — Validation Report

Date: 2026-10-23. All results below are from commands actually executed on the
real repository during this phase — nothing is reported as passed unless it ran
successfully. Statuses: **PASS** / **FAIL** / **BLOCKED** (correctly cannot run
in this environment, with the reason) / **NOT RUN** (not executed here).

## 0. Environment & starting ground truth

| Item | Value | Verified |
| --- | --- | --- |
| Repo | `E:\Projects\fathom-workflow`, branch `main` | ✅ |
| HEAD before this phase | `a145d57` "Phase 2: project foundation, locked decisions, and specification" (not amended/rewritten) | ✅ |
| Git remote | **none** (`git remote -v` empty) — by design, ADR-001 | ✅ |
| Upstream clone | `E:\Projects\saga-orchestration-go` untouched (its own `docs/` only) | ✅ |
| Go | `go1.26.5 windows/amd64` | ✅ |
| Docker Engine / Compose | `29.7.2` / `v5.5.0` (daemon live) | ✅ |
| gcc / C toolchain | **absent** (`where gcc` → not found) — drives the race BLOCKED case | ✅ |

Two Go modules: product `github.com/Lakhyajit-96/fathom` and non-product
`github.com/Lakhyajit-96/fathom/tools`.

## 1. Validation matrix (executed on the Windows dev host unless noted)

| # | Check | Command | Exit | Status |
| --- | --- | --- | --- | --- |
| 1 | Formatting | `gofmt -l -s .` (via `task fmt:check`) | 0 | **PASS** (clean) |
| 2 | Vet — product | `go vet ./...` | 0 | **PASS** |
| 3 | Vet — tools | `cd tools && go vet ./...` | 0 | **PASS** |
| 4 | Lint (staticcheck v0.8.2) both modules | `task lint` | 0 | **PASS** (no findings) |
| 5 | Unit tests — product | `go test ./...` | 0 | **PASS** — 36 tests, 0 failures |
| 6 | Race tests | `task test:race` (`go test -race ./...`, CGO=1) | 2 | **BLOCKED** — `go: -race requires cgo; enable cgo by setting CGO_ENABLED=1`, and no `gcc` on host. Runs in Linux CI (`ci.yml`), not faked here. |
| 7 | CGO-disabled host build | `CGO_ENABLED=0 go build ./...` (both modules) | 0 | **PASS** |
| 8 | Cross-compile linux/amd64 | `GOOS=linux GOARCH=amd64 go build ./...` (both) | 0 | **PASS** |
| 9 | Cross-compile linux/arm64 | `GOOS=linux GOARCH=arm64 go build ./...` (both) | 0 | **PASS** |
| 10 | Dependency integrity | `go mod verify` (both modules) | 0 | **PASS** — "all modules verified" |
| 11 | Dependency tidiness | `go mod tidy -diff` (both modules) | 0 | **PASS** — empty diff (no drift) |
| 12 | Repo hygiene/secret guards | `task hygiene` (`go test ./internal/hygiene/...`) | 0 | **PASS** |
| 13 | Secret scan (manual) | regex sweep for `password/secret/token/key/…=value` over tracked files | — | **PASS** — only obviously-fake `fathom-smoke-not-a-secret` (smoke stack) and a doc line in `THREAT_MODEL.md`; no real credentials, no key material, `.env` git-ignored |
| 14 | Tracked-file review | `git add -A -n` | — | **PASS** — 27 intended files; no binaries, no `.env`, no secrets |
| 15 | Compose config valid | `docker compose -f deploy/docker-compose.smoke.yaml config` + `up --wait` | 0 | **PASS** — all 3 services reached *healthy* |
| 16 | franz-go broker round-trip | `tools/kafkasmoke` vs live `apache/kafka:4.3.1` | 0 | **PASS** — topic create + produce 8 (acks=all) + consume/verify headers + commit |
| 17 | CDC smoke (connector RUNNING + routed event) | `scripts/cdc-smoke.sh` (full 6 steps) | 0 | **PASS** — see §3 |
| 18 | Workflow syntax | `actionlint .github/workflows/*.yml` | 0 | **PASS** — no findings |
| 19 | CI jobs actually executed | `ci.yml` / `cdc-integration.yml` on GitHub runners | — | **NOT RUN** — no remote exists; cannot execute. Syntax validated only (#18). |

## 2. Dependency decisions (evidence-based, §4)

### Kafka client → **franz-go** (ADR-005)
Measured, not assumed:
- `confluent-kafka-go/v2` **fails** to build on this host: with `CGO_ENABLED=0`
  the API is compiled out (`undefined: kafka.Consumer`); with `CGO_ENABLED=1`
  it needs `gcc`, which is absent. It would permanently reintroduce the exact
  native-toolchain/librdkafka dependency that made the audited repo unbuildable.
- `franz-go` v1.22.2 + `kadm` v1.19.0 build with `CGO_ENABLED=0` on
  windows/amd64 and cross-compile to linux/amd64+arm64 (exit 0), and passed a
  **live broker round-trip** (#16) exercising admin create, idempotent produce
  with all-ISR acks, consumer-group read-back with header verification, and
  manual offset commit.
- Selected for the CDC-mode relay only; the default `pgoutbox` relay stays
  pure-Go with no broker. Rejected alternative and corrected API facts are in
  ADR-005. Transactions/EOS are available but intentionally unused (design is
  at-least-once outbox + consumer dedup, ADR-011).
- franz-go/kadm are pinned in the **`tools/` module only**, keeping the product
  module free of Kafka deps at this foundation stage.

### UUID → **`github.com/google/uuid` v1.6.0**, UUIDv7 (ADR-018)
- stdlib has no RFC 9562 UUID; `gofrs/uuid/v5` (v5.5.1) was the rejected
  alternative (also has V7). `google/uuid` v1.6.0 ships `NewV7`/`NewV7FromReader`
  with in-process monotonic ordering — verified by `internal/id` tests (canonical
  V7 shape, uniqueness over 10k, strict monotonic ordering over 5k,
  deterministic-from-supplied-entropy).
- This is the product module's **only** direct external dependency.

### Kafka/Debezium image pair → measured via real Compose smoke (ADR-007)
Fixed to `apache/kafka:4.3.1` + `quay.io/debezium/connect:3.7.0.Final` +
`postgres:17.11-alpine`, chosen from Debezium 3.7 release notes ("built against
Kafka Connect 4.3.1 and tested with 4.3.1 brokers"). Pinned by **tag and digest**
(explicit versions, no `latest`):

| Image | Digest |
| --- | --- |
| `apache/kafka:4.3.1` | `sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837` |
| `quay.io/debezium/connect:3.7.0.Final` | `sha256:b21f23bc8ef2d436209060b4cbbb9fbfd70053ce13e32b015d75b2823c901fc8` |
| `postgres:17.11-alpine` | `sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb` |

## 3. CDC smoke — full evidence (executed end-to-end this session)

`scripts/cdc-smoke.sh` reached `SMOKE PASS`, exit 0:

1. `[1/6]` kafka + connect + postgres all *healthy* under `up -d --wait`.
2. `[2/6]` `kafkasmoke PASS` — `topic "fathom-smoke-rt" ready`, produced 8
   (idempotent, acks=all, traceparent header), consumed 8, payloads+headers
   verified, offsets committed.
3. `[3/6]` `Connect REST ready after 5 polls` → connector `POST` → **HTTP 201**.
4. `[4/6]` `RUNNING after 2 polls` — connector **and** task `RUNNING`,
   version `3.7.0.Final`.
5. `[5/6]` outbox row inserted.
6. `[6/6]` routed record read from `smoke.events`:
   `key=agg-smoke`, headers include `eventType:RoomReserved`, `id:evt-smoke`,
   `__debezium.context.connectorLogicalName:fathomcdc`, value
   `{"ok":true,"wf":"fake"}` (JSONB expanded).

Torn down with `down -v` (exit 0); `docker compose ps -a` afterwards shows no
residual containers.

**Two real reproducibility bugs were found by running this on Windows and are
now fixed in the script** (documented in ADR-007): (a) a Kafka-Connect
REST cold-start race (register POST returned empty until the API was polled to
`200`), and (b) Git-for-Windows MSYS rewriting the in-container `/opt/kafka/...`
path (fixed with `MSYS_NO_PATHCONV=1`). These were previously masked because the
routing had been confirmed manually rather than via the script; the script is now
genuinely reproducible and is the shared source of truth for the CI job.

## 4. Tests added (no placeholders)

36 deterministic unit tests across 5 packages, no broker/DB required:
`internal/config` (9), `internal/logging` (7), `internal/id` (6),
`internal/app` (6), `internal/hygiene` (3). They assert real behaviour:
secret redaction across format verbs and JSON, error messages that name keys but
never values, log-time key scrubbing (case-insensitive, grouped), UUIDv7
canonical/uniqueness/monotonicity/deterministic-entropy, context-cancel return,
LIFO shutdown, error propagation, bounded shutdown, and repo secret guards.

## 5. CI authored (not executed)

`ci.yml` and `cdc-integration.yml` are committed and **actionlint-clean**, but
have **NOT RUN** — there is no remote (ADR-001) and creating one is explicitly
out of scope. The Linux-only checks (`go test -race`, and the CDC integration
job on ubuntu runners) are wired but unexecuted here; their Windows equivalents
are covered above (race = BLOCKED, CDC = PASS locally).

## 6. Deviations from Phase 2 specs

None of substance. Phase 2 specs are intact; ADRs were **amended with evidence**,
not overwritten:
- ADR-005: added the live round-trip verification and corrected franz-go API
  facts discovered by measurement.
- ADR-007: discharged the "image compatibility" open item with a real smoke
  result; recorded 2 Debezium EventRouter gotchas + 2 cross-platform script bugs.
- ADR-004: recorded the two-module split (`tools/` isolation) and one product dep.
- ADR-018 (new): UUID strategy decision.

## 7. Remaining risks / blockers

- **Race detector** cannot run on the Windows dev host (no gcc). Mitigated: runs
  in Linux CI once a remote exists; locally `go test ./...` covers the logic.
- **CI never executed** — only syntax-validated. Becomes real on first push to a
  remote (later, user-authorized).
- **CDC integration CI job** uses `scripts/cdc-smoke.sh`; the script is now proven
  cross-platform on Windows, but its first GitHub-runner execution is still pending.
- Foundation contains **no engine/business code** by design — this is not
  production-ready and does not claim to be.

## 8. Reproduce everything locally

```sh
task fmt:check && task vet && task lint && task test && task build && task build:linux && task deps:verify && task hygiene
task cdc:smoke          # needs Docker + Compose v2
task test:race          # Linux only (BLOCKED on Windows host by design)
```
