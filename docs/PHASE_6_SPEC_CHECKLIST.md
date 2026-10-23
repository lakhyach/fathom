# Phase 6 Compliance Checklist — Premium Operations Cockpit & Real API Integration

Normative inputs: the Phase 6 brief (2026-10-23) + `OBSERVABILITY_AND_UI_SPECIFICATION.md`
(cockpit IA, honesty rules, visual direction) + `DATA_AND_API_CONTRACTS.md` §B +
`THREAT_MODEL.md` (T-05/T-08/T-10) + ADR-014 (stack pins) + `PHASE_5_VALIDATION_REPORT.md`
(what the backend actually serves). Seams verified against the implementation
(`internal/api/api.go` routes, `handlers.go` params, `dto.go` shapes,
`internal/metrics/collector.go` series), not against the docs' hopes.

## §1 Inspection findings (verified 2026-10-23)

- Git: clean tree at `15a01fb` (Phase 5). **No frontend exists** — no `web/`, no
  `package.json` anywhere; README's layout reserves `web/` for the cockpit.
- Toolchain: Node v24.16.0, npm 11.13.0 on the host.
- API surface as BUILT (12 authed `/v1` routes + `/healthz` `/readyz` `/metrics`);
  no CORS middleware → the cockpit runs behind the Vite dev proxy (UI spec §5
  always intended this), so the backend needs zero changes.
- Auth as BUILT: `Authorization: Bearer <key>`; roles reader ⊂ operator ⊂ admin;
  keys come from `FATHOM_API_KEYS` server-side. No session cookie/CSRF yet
  (ADR-013: cockpit session is a later phase) → the cockpit holds a user-entered
  bearer key locally, never in source (brief §6).
- Pagination as BUILT: `?limit&cursor`, `next_cursor` in the envelope; cursors are
  workflow UUIDs (lists) or seq numbers (`/events`).
- Readiness as BUILT: `/readyz` = checks map (database, relay_lag) → 200/503.

## §2 Endpoint → screen matrix (only verified endpoints appear)

| Screen | Endpoint(s) actually called | Notes |
| --- | --- | --- |
| Overview dashboard | `GET /v1/workflows` (recent page), `GET /metrics` (state census via `fathom_workflows_total{def_name,state}`), `/healthz`+`/readyz` | counts are real DB census, not list-length |
| Workflow explorer | `GET /v1/workflows?state=&business_key=&cursor=&limit=` | server filters: state + exact business key only |
| Execution inspector | `GET /v1/workflows/{id}` (embeds `steps[]`), `/events` (audit feed, kinds TRANSITION/EVENT_CLASSIFIED/DEADLETTER/OPERATOR_ACTION), `/inbound`, `/attempts` | graph = ordered step chain from `def_snapshot` (steps are a sequential list — no `depends_on` in the wire schema; `step.position` is the declaration index) + `compensator_task` reverse edges; node state from `step.state`; attempt badges from `step.active_attempt`. UI-spec §5 assumed a richer layout schema than stored — honest adaptation recorded |
| Inspector actions | `POST /v1/workflows/{id}/actions:cancel` / `actions:retry-now` (body `{reason, version}`, 409 CONFLICT_RETRY carries current version) | confirm dialog shows target + consequence; version re-read on 409 |
| DLQ center | `GET /v1/dlq?open=&class=&workflow_id=`, `POST /v1/dlq/{id}/actions:resolve` `{action: force-terminate|complete-compensation, reason, dry_run}` | **dry-run preview is real** (UI spec §3.3 satisfied); resolve 404s on unknown id |
| Events/audit explorer | per-workflow `/events` + `/inbound` (classification shown — DS-1 visibility) | no global feed endpoint exists (gap G2) → explorer is workflow-scoped + DLQ queue as cross-workflow surface |
| Metrics & health | `GET /metrics` (Prometheus text, parsed client-side), `/healthz`, `/readyz` | exactly the 11 wired series; nothing else is charted |
| Settings & diagnostics | key entry (localStorage, local-dev label), base-URL probe against `/healthz`+`/readyz`, `GET /v1/definitions` (connection proof), `POST /v1/definitions` (admin-only), `POST /v1/workflows` (operator; client generates `Idempotency-Key`) | definition register + create-workflow form = the real "create → execute → watch" loop (brief §8) |

## §3 Verified gaps — shown as unavailable, never faked (backend follow-ups)

- **G1 SSE `/v1/stream` not implemented** (deferred Phase 5) → bounded polling
  (detail 3 s / lists 8 s / metrics 15 s, 429 honours `Retry-After`); status badge
  renders `snapshot @ <ts>`, never "live" (honesty rule 4).
- **G2 no global audit/events endpoint** → audit explorer is per-workflow; documented.
- **G3 no worker registry/heartbeat API** → no Workers screen; lease holder +
  `fathom_worker_leases_held` gauge are the only worker facts the UI may show.
- **G4 no time-series history endpoint** → no sparkline trends/Δ% (the reference
  image's "+12%" arrows would be fabricated); point-in-time gauges + deltas the UI
  computes itself from its own polls are labelled as such.
- **G5 spec §2 series not wired**: `step_attempt_duration` histogram, `retries_total`,
  compensation/idempotency/operator-action counters → not charted; attempt durations
  come from `/attempts` rows instead.
- **G6 no OpenAPI document** → TS types hand-written from `dto.go` + contract tests
  (deviation from UI spec §5 "generated types"; drift risk documented).
- **G7 no OTLP/Jaeger** → `trace_id` displayed from audit rows, no external link.
- **G8 `actions:abandon` not served** (recorded in Phase 5 report) → no abandon button.
- **G9 audit rows do not expose the operator-action name column** → OPERATOR_ACTION
  rows render kind + detail JSON only.

## §4 Stack decisions (brief §3 evaluation, ADR-014 pins kept)

- **Vite 8.3.5 + React 19.3.1 + TS** — pinned per ADR-014; `web/` is its own npm
  project (Go module untouched).
- **Graph: `@xyflow/react` 12.12.0** (MIT, maintained; the spec's chosen lib).
  Layout computed from definition `position` + transition edges — deterministic,
  golden-tested (UI spec §5).
- **Server state: `@tanstack/react-query` 5.104.5** (MIT) — query cache only.
- **Routing: `react-router` 7** (MIT, active) — 7-route SPA.
- **Charts: custom SVG components** (area/bars/rings) instead of recharts — 11 known
  series need exact premium styling at ~0 KB extra deps; evaluation recorded.
- **Motion: CSS transitions + WAAPI via a tiny `useReveal` hook** instead of
  framer-motion — bundle discipline; every animation keyed to real data changes and
  gated by `prefers-reduced-motion`.
- **Fonts: `@fontsource-variable/inter` + `@fontsource-variable/jetbrains-mono`**
  (SIL OFL 1.1, self-hosted, offline-reliable) per UI spec §4.
- **Icons: hand-drawn Fathom SVG set** (1.5px stroke, 24px grid) — "custom
  Fathom iconography" is a brief requirement; no icon library.
- **Tests: Vitest + Testing Library + jsdom** — client, tokens, graph layout
  golden maps, problem+json handling, state colour table.

## Acceptance matrix

| # | Brief requirement | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Inspect before implementing | this doc + git survey | ☐ |
| 2 | Distinctive visual direction (obsidian/navy, blue/violet, premium type) | tokens + browser screenshots | ☐ |
| 3 | Deps evaluated (maintenance/license/size), reusable components + theme | §4 + `web/src/theme` | ☐ |
| 4 | 7 screens on real data, honest unavailable states | routes + §3 gaps | ☐ |
| 5 | Graph = signature screen: real steps/deps/states/attempts, keyboard, reduced-motion | Inspector + golden tests | ☐ |
| 6 | Typed client, real paths/auth/pagination, no fixture bleed, no embedded keys | `web/src/api` + settings | ☐ |
| 7 | Micro-interactions, a11y, every button real or disabled-with-reason | polish pass + browser audit | ☐ |
| 8 | Builds/lint/tests + real-browser validation desktop+mobile, live end-to-end | PHASE_6_VALIDATION_REPORT.md | ☐ |
| 9 | Docs + single local commit, no remote/push/deploy | git log + report | ☐ |
