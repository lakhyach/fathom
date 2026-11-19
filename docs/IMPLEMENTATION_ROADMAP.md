# Implementation Roadmap — Phase 3 onward

> Historical sequencing plan authored before implementation. Phases 3–8 have
> since been delivered; see the phase validation reports and current repository
> status in `README.md`. Public deployment remains gated by `THREAT_MODEL.md`.

Supersedes the effort sketches in Phase 1's roadmap with the locked Phase-2 architecture. Phases are **gate-ordered**: a phase cannot start until the previous exit gate passed in CI (evidence = job exit codes, per Phase 1 reporting discipline). Test IDs reference `RELIABILITY_AND_FAILURE_TEST_PLAN.md`; ADR IDs reference `ARCHITECTURE_DECISIONS.md`.

Codename throughout: **Fathom** (ADR-002).

---

## Phase 3 — Foundation + Engine core

### M3.1 Repo & toolchain foundation (`1–2 d`)
Go module `github.com/lakhyach/fathom` at root; `cmd/fathom-control`, `cmd/fathom-worker`, `cmd/fathom-relay` stubs; `golang-migrate` wiring; env-only config (struct with defaults; `.env.example` with obviously-fake values); `Taskfile` (`up/lite`, `up-cdc`, `test`, `lint`, `demo`); golangci-lint (+ the RT-08 hygiene greps: no tracked `password:`, bare `host:port` dsn/servers lint, digest-pinned images check); GitHub Actions `ci.yml` (Linux: unit+contract+integration with testcontainers; Windows lane: pure tiers). Publication was later authorized and is recorded in the current repository status.
**Gate 3.1:** `go build ./...`, `go vet ./...`, `gofmt -l`, lint, CI-equivalent task suite green on Windows host with `CGO_ENABLED=0` **and** via Linux container; migrations up/down cycle clean; zero secrets tracked.

### M3.2 Schema & store (`2–3 d`) — depends on M3.1
Migrations for DATA doc §A exactly (constraints and indexes are the spec); repository layer with the guarded UPDATE API (state machine §2) as the **only** write path; append-only grant setup; testcontainers harness.
**Gate 3.2:** constraint tests pass: business-key partial unique rejects 2nd active workflow; terminal-state UPDATE affects 0 rows (direct SQL attempt); `audit_event` UPDATE/DELETE denied to app role; `room_stay` EXCLUDE blocks overlapping ranges (seeds AT-09's invariant); outbox seq monotonic under 100 concurrent tx.

### M3.3 Pure engine + ingress classifier (`3–4 d`) — depends on M3.2 (types), no I/O in engine
`internal/engine`: state machine as pure transition function + exhaustive table from WORKFLOW doc §2; `internal/ingress`: classification pipeline (§5 order); envelope types + validation (§E). Fuzz/property harness wired.
**Gate 3.3:** `TestFathom_AT12_*` property suite green (10³ CI); unit form of **AT-01** green (re-authored terminal event = zero effect); `engine` coverage ≥ 85%; every W-transition has a named test; `-race` clean; **this gate is the Phase-1 CONDITIONAL-GO condition #3 discharged.**

### M3.4 Outbox + pgoutbox relay + reaper/scheduler (`3–4 d`) — depends on M3.3
Relay interface + `pgoutbox` impl (claim → produce to in-proc/NATS-free pipe target for lite mode → mark published + cursor); deadline reaper + retry scheduler (`SKIP LOCKED` loops); pruning job; `/healthz|/readyz|/metrics`.
**Gate 3.4:** lite-mode conformance suite green (T-RELAY against pgoutbox); AT-05 (relay-kill) green in T-CHAOS harness; `fathom_relay_publish_lag_seconds` present; reaper double-instance test shows no lost or duplicate *claims* (RT-07).

### M3.5 Control-plane API + SSE (`2–3 d`) — depends on M3.2; parallel with M3.3/4
REST per DATA §B with problem+json, OpenAPI document authored first (types codegen for web depends on it); idempotency store; RBAC middleware; SSE with `Last-Event-ID` backfill.
**Gate 3.5:** AT-10 green; status-code discipline test (storage fault ⇒ 500, never 404 — DS-13); RT-06 green (SSE resume exact); OpenAPI doc validated in build.

### M3.6 Showcase workers with participant contract (`2–3 d`) — depends on M3.4
`fathom-worker` running booking (date-range inventory), payment (ledger + demo-gateway rules), confirmation (third step) against the §E contract incl. `command_inbox` + fencing checks + participant outbox.
**Gate 3.6:** AT-02, AT-09, AT-11 green end-to-end (lite relay); three-step compensation ordering demonstrated (step-3 failure compensates 2 then 1, ledger-evidenced refund).

### M3.7 Phase-3 e2e integration (`1–2 d`) — depends on all above
Compose lite stack (control + workers + relay + Postgres only); `make demo` script v1 (success, compensation, timeout+retry, replay-rejection, crash-recovery).
**Gate 3 (Phase 3 exit):** full blocking set green in CI: **AT-01…AT-12 + RT-01…RT-08 minus CDC-lane items** (deferred to P4); `fathom_oldest_open_workflow_age_seconds` < 2×deadline in a 10-min soak; report written as `docs/phases/PHASE_3_RESULTS.md` with commands + exit codes.

## Phase 4 — Transport breadth & CDC (`4–6 d`)
CDC relay (Debezium pinned, ADR-007) behind the same conformance suite; franz-go consumer group with manual commit + `processed_events` ack-before-commit wiring; Connect-restart chaos test.
**Gate 4:** same suite green in `cdc` lane; Phase 1's SKIPPED §5.5 (connector restart/resume) becomes a passing named test; zero double/lost effects under offset replay.

## Phase 5 — Observability depth (`2–3 d`)
OTel span-per-decision end-to-end; Jaeger in compose; full metric set (OBSERVABILITY §2); log-field lint.
**Gate 5:** AT-06 metric assertion (`DUPLICATE` counter > 0 after replay test); every timeline datum resolves to a stored row or series; `/readyz` relay-threshold test.

## Phase 6 — Cockpit (`6–9 d`)
Only after Gates 3–5. Build order inside phase: API client + generated types → list/detail with SSE → graph → timeline → DLQ console → sim lab → audit views. Honesty checklist (§3.5) is a PR-review template.
**Gate 6:** the 5-minute acceptance narrative (OBSERVABILITY §6) executed live and screen-recorded; Lighthouse a11y ≥ 90; RT-06 UX test (pull network, reconnect, no gaps).

## Phase 7 — Ship (`4–5 d`, all external actions need explicit authorization)
Security pass (dep+secret scan, Trivy, threat-model re-read vs. THREAT_MODEL.md); docs (README guarantees table, ADRs published, runbooks); deploy decision + target (currently **unauthorized** — nothing billable exists); claims audit: every public sentence cites a test ID or metric.
**Gate 7 (product):** clean-clone → `task up-lite` → demo in <10 min by a first-time user; CI badge green (after repo publication authorization); zero secrets in images; attribution present.

---

## Sequencing and parallelism

```
M3.1 → M3.2 → M3.3 → M3.4 → M3.6 → M3.7 → P4 → P5 → P6 → P7
              │        └── M3.5 (parallel from M3.2) ──┘
```
Hard rules: no UI before Gate 3; no CDC lane before Gate 3 (it inherits the conformance suite); engine transitions never gain I/O shortcuts "just for now" (the pure-function boundary is what makes AT-12 cheap).

## Prerequisites still open before/inside Phase 3

1. **User authorization:** module path `github.com/lakhyach/fathom` assumed for eventual publication; if the public repo will differ, say now (module rename is cheap at M3.1, expensive after).
2. GitHub publication itself remains **unauthorized** — CI files ship dark, enabled at publication time.
3. Postgres 17 in containers (host has none) — acceptable; testcontainers covers it.
4. Naming: codename **Fathom** is internal-only until the Phase-7 brand check (ADR-002).
