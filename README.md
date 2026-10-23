# Nunatak — workflow control plane

*(Internal codename **Fathom**; the Go module path, `fathom` binary/modes and
`fathom_*` metric series intentionally keep that name — “Nunatak” is the visible
product name for the operations cockpit.)*

A distributed **workflow control plane** with a real-time operations cockpit: observable,
recoverable workflow execution with verifiable failure handling.

> **Status: through Phase 5 — durable engine, workers, recovery scheduler, REST API, and the pgoutbox relay are implemented and validated locally** (see `docs/PHASE_4_VALIDATION_REPORT.md`, `docs/PHASE_5_VALIDATION_REPORT.md`).
> Nothing in this repository may be described as "implemented" unless a named test
> proves it. See `docs/` for the contracts; see the Phase 1 audit
> (`E:\Projects\saga-orchestration-go\docs\`) for the evidence base this project is
> built against.

## Provenance

This is an **original implementation in a new repository with no git history from
upstream**. Design concepts were informed by
[`semotpan/saga-orchestration-go`](https://github.com/semotpan/saga-orchestration-go)
(MIT, Copyright (c) 2023 Serghei Motpan), audited in October 2026. Three mechanisms
were re-used **as concepts only, re-implemented from scratch**; everything else is
new. Full ledger: [`docs/ATTRIBUTION_AND_LICENSES.md`](docs/ATTRIBUTION_AND_LICENSES.md).

The upstream clone at `E:\Projects\saga-orchestration-go` is untouched and this
repository has **no remote** — it must never push to the upstream author's repo.

## Repository layout

```
docs/          specification deliverables (the contracts) + per-phase checklists & validation reports
cmd/fathom/    ONE binary, modes: control | worker | relay | all       (Phase 5)
internal/      engine, store, worker, scheduler, relay, api, health, metrics, tracing (Phase 5)
db/            embedded versioned migrations 0001–0002                 (Phase 4–5)
deploy/        docker compose smoke (Kafka+Debezium CDC proof)         (Phase 3)
web/           operations cockpit (React SPA) — Vite + React 19 + React Flow   (Phases 6 & 6.1)
tools/         separate module: CGO portability probe + franz-go round-trip smoke
.github/workflows/  ci.yml + cdc-integration.yml (authored; run once a remote exists)
```

## Toolchain (pinned, verified on this host 2026-10-23)

| Tool | Version |
| --- | --- |
| Go | `go1.26.5 windows/amd64` (`CGO_ENABLED=0` builds — no C toolchain required) |
| Node / npm | `v24.16.0` / `11.13.0` |
| Git | `2.54.0.windows.1` |
| Docker Engine / Compose | `29.7.2` / `v5.5.0` (note: Compose v5 rejects `--progress` on `up`) |
| PostgreSQL target | 17+ (`postgres` role, non-root) — engine state, outbox, leases, audit |

## Read in order

1. `docs/PRODUCT_SPECIFICATION.md` — what we are building and for whom
2. `docs/ARCHITECTURE_DECISIONS.md` — every locked decision + evidence + rejected alternatives
3. `docs/WORKFLOW_STATE_MACHINE.md` — the normative state machine
4. `docs/DATA_AND_API_CONTRACTS.md` — schema + REST/SSE contracts
5. `docs/RELIABILITY_AND_FAILURE_TEST_PLAN.md` — acceptance tests derived from Phase 1 defects
6. `docs/OBSERVABILITY_AND_UI_SPECIFICATION.md` — cockpit spec
7. `docs/IMPLEMENTATION_ROADMAP.md` — Phase 3+ sequence and gates
8. `docs/THREAT_MODEL.md` — trust boundaries and mitigations
9. `docs/ATTRIBUTION_AND_LICENSES.md` — provenance and dependency licenses
