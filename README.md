# Fathom (internal codename)

A distributed **workflow control plane** with a real-time operations cockpit: observable,
recoverable workflow execution with verifiable failure handling.

> **Status: Phase 2 — specification & foundation locked. No engine code exists yet.**
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
docs/          Phase 2 specification deliverables (the contracts)
cmd/           binary entrypoints          (Phase 3 — empty)
internal/      engine, store, relay, api   (Phase 3 — empty)
db/            migrations                  (Phase 3 — empty)
deploy/        docker compose, connect     (Phase 3 — empty)
web/           cockpit (React SPA)         (Phase 5 — empty)
tests/         e2e scripts, fixtures       (Phase 3 — empty)
scripts/       dev/CI helpers              (Phase 3 — empty)
tools/depprobe dependency-portability probe (built, evidence in docs/ARCHITECTURE_DECISIONS.md ADR-005)
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
