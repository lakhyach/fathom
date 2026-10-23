# Observability & Cockpit Specification

Two halves, one rule: **the cockpit is a renderer over the audit trail.** If a fact is not in `audit_event`/`workflow`/`step`/`attempt`/`inbound_event` or a Prometheus series, it cannot appear in the UI (`REQ-U-1`). Phase 1's lesson — a "PENDING forever" status indistinguishable from abandonment — is a UI spec problem as much as an engine problem.

---

## 1. Telemetry architecture

| Signal | Implementation | Destination (local) | Correlation |
| --- | --- | --- | --- |
| Logs | `log/slog` JSON, one format from `cmd/` to handlers | stdout → compose logs | every line with engine context carries `workflow_id`, `step_type`, `attempt`, `trace_id` — enforced by a lint rule + a unit test on the logger helper |
| Traces | OTel SDK v1.47, OTLP/HTTP; span per engine decision, per relay publish, per participant attempt | Jaeger (all-in-one, compose) | `traceparent` in envelope (ADR-010); `causation_id` links spans across async hops where trace context restarts |
| Metrics | Prometheus `client_golang` v1.25, `/metrics` per process | Prometheus (compose) | — |
| Audit | `audit_event` table (append-only, grant-guarded) | Postgres → REST/SSE | this *is* the product's ground truth; telemetry decorates it, never replaces it |

Health: `/healthz` (process), `/readyz` (DB reachable **and** relay lag < threshold — threshold violation makes `/readyz` fail, test-gated per Phase 1 roadmap gate 5).

## 2. Metric set (normative names; several are exit-gate inputs)

| Series | Type | Gates / used by |
| --- | --- | --- |
| `fathom_workflows_total{def_name,state}` | counter/gauge | overview |
| `fathom_workflow_transitions_total{from,to,reason_code}` | counter | decision visibility (REQ-OP-3) |
| `fathom_oldest_open_workflow_age_seconds` | gauge | **exit gate** (REQ-C-5); readiness contributor |
| `fathom_step_attempt_duration_seconds{step_type,outcome}` | histogram | timelines, SLO demo |
| `fathom_events_classified_total{classification}` | counter | **AT-01/06 assertions** — proves rejection paths actually fire |
| `fathom_outbox_unpublished_count`, `fathom_relay_publish_lag_seconds{relay}` | gauge | relay health; `/readyz` |
| `fathom_retries_total{step_type,class}` / `fathom_compensation_failures_total` | counter | DLQ narrative |
| `fathom_dlq_depth{class}` / `fathom_dlq_oldest_age_seconds` | gauge | operator queue |
| `fathom_idempotency_replays_total{layer}` | counter | AT-02/10 evidence |
| `fathom_operator_actions_total{actor,action}` | counter | audit surface |

## 3. Cockpit information architecture

Routes (SPA, RBAC-aware): `/` Overview · `/workflows` List+search · `/workflows/:id` Detail · `/dlq` · `/sim` Failure lab · `/audit/:workflowId` · `/definitions` · `/settings` (session, role switch for demo).

**3.1 Workflow detail (the centrepiece).** One screen, three synced panes, zero fabricated motion:
- **Graph** (`@xyflow/react`): nodes = steps from `step` rows, edge labels from `audit_event` transitions; node badge = `active_attempt ×N`, state-coloured; compensating path rendered as the reverse edges actually taken. Clicking a node selects the step; **the graph is generated from persisted transitions — there is no static layout in code**.
- **Timeline** (custom gantt over `attempt` rows): issue→start→result/timeout bands per attempt, retry gaps showing backoff, lease-expiry markers, compensation spans; a "why" chip on every band opening the decision audit row (`reason_code` + detail).
- **Event/trace/audit panel**: raw `inbound_event` rows *with their classification* (the DS-1 visibility window: a replayed event is *shown* being ignored, not silently ignored); state version history; `traceparent` link into Jaeger for that workflow; SSE live-append while open.

**3.2 List & search.** Filters state/def/business-key/date; keyset pagination; row sparkline from stored timings only. Live: transitions arrive via SSE (`workflow.transitioned`), badges update from data.

**3.3 DLQ console.** Queue (`GET /v1/dlq`), each item: class, `reason_code`, raw event ref, workflow snapshot. Actions = `retry-now / force-terminate / complete-compensation` with **mandatory reason**, role check surfaced from API error codes, **dry-run preview** rendering the computed effect before execution, and post-action audit receipt (seq id). UI never offers raw-event re-emit (state machine §7).

**3.4 Failure-simulation lab (`/sim`).** Buttons map 1:1 to *real* admin API endpoints backed by hooks in the demo workers/engine — each card states the guarantee it tests and shows live evidence: drop a participant's responses (→ AT-08 path), kill a worker process (→ AT-03/04), poison a compensator (→ AT-07), replay an already-applied event through the relay (→ **AT-01, the flagship demo: watch the engine classify it `TERMINAL_IGNORED` while status stays `COMPLETED`**), pause/resume relay (→ AT-05). Lab actions are labeled **"synthetic injection"** in the UI and are themselves audited (`operator_action`).

**3.5 Honesty rules (blocking review checklist).** (1) no metric/widget without a backend series or table; (2) demo fixtures tagged `DEMO` (seed data flag from API); (3) controls that can't reach a real endpoint don't exist; (4) "live" badge requires an open, confirmed SSE stream, else `snapshot @ <ts>`; (5) all times UTC with local toggle — never engine-ambiguous (Phase 1 showed payload mutation confusion; our clock policy is explicit).

## 4. Visual direction

Dark, quiet, technical-premium: near-black surfaces (`oklch` palette, 2 accent hues — one semantic status set, one interactive), Inter + one mono (JetBrains Mono) for envelopes/IDs, 1px borders, hairline dividers, generous density; motion only for state changes that came from data (transition flashes keyed to `audit_event.seq`). Explicit anti-references: default admin-dashboard templates (bootstrap-purple gradients, card shadows everywhere, sparkline decoration), "hacker terminal" cosplay. Status colour system is one place in code (`tokens/status.ts`): `COMPLETED` teal, `RUNNING/COMPENSATING` amber, terminal-negative rose, `FAILED_MANUAL` red with persistent icon — colour-blind-safe pairing with text badges, never colour alone.

## 5. Frontend engineering contract

- Vite 8 + React 19 + TS (pinned per ADR-014); TanStack Query server-state only, no client cache of engine state beyond the query cache; SSE hook (`useFathomStream`) manages reconnect/backfill per DATA doc §C (its acceptance is RT-06).
- Graph via `@xyflow/react` 12 (MIT); layout computed from `position` + transition edges — deterministic, tested with golden node maps.
- a11y target: keyboard-navigable list/detail/DLQ; Lighthouse a11y ≥ 90 on cockpit shell (Phase 1 roadmap gate carried); colour tokens pass WCAG AA on their surfaces.
- Components render from API types generated from the OpenAPI document (single source; TS types generated in build, drift = build failure).
- Dev server proxies `/v1` to the control plane; web runs without Kafka/Debezium (lite relay) so frontend work never depends on the CDC stack.

## 6. What the cockpit must demonstrate at the end (acceptance narrative for gate P-UI)

Within 5 minutes, without SQL: run the happy workflow live; watch a step time out and retry with visible backoff and reason; trigger compensation; kill a worker and see the lease recover under a new attempt; replay an event and see `TERMINAL_IGNORED` while state holds; resolve a DLQ item with reason + audit receipt; open the Jaeger trace for the same workflow. Each of those six moments is a scripted step in `make demo` (REQ-OP-7) backed by the AT IDs.
