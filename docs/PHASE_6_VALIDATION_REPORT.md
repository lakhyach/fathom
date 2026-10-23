# Phase 6 Validation Report — Premium Operations Cockpit & Real API Integration

Executed: 2026-10-23. Companion to `PHASE_6_SPEC_CHECKLIST.md` (the endpoint→screen
matrix, stack decisions and gap list G1–G9 live there and are **not** repeated).
This report records only what was **actually run and observed**: static gates, unit
tests, and a real-browser pass against the live control plane at desktop and mobile
sizes, plus the defects that pass surfaced and the fixes applied.

No backend semantics were changed to satisfy the UI. No remote, push, deploy, or
public exposure was performed. All results below come from a running application,
not the inspiration image.

---

## 1. Environment & reproduction

| Fact | Value |
| --- | --- |
| Baseline commit at start | `15a01fb` (Phase 5), branch `main`, clean tree, no remote |
| Frontend | new `web/` — Vite 8.3.5 + React 19.3.1 + TS 5.9.3 (own npm project; Go module untouched) |
| Postgres | docker `fathom-pg17`, host `127.0.0.1:5434`, db `fathom_test`, role `postgres` (migrations already applied — 13 tables) |
| Backend run | `bin/fathom.exe all` (single binary) with the DSN + keys + echo below |
| Frontend run | `npm run dev` (Vite) → http://localhost:5173, dev proxy forwards `/v1`,`/healthz`,`/readyz`,`/metrics` to `127.0.0.1:8080` |

Exact backend launch (dev wiring only — every value below is an obviously-fake
loopback secret, matching the committed examples in `DEVELOPMENT.md`; nothing real
is embedded anywhere in the frontend):

```
FATHOM_DATABASE_URL=postgres://postgres:fathom@127.0.0.1:5434/fathom_test?sslmode=disable
FATHOM_API_KEYS='rd:reader:dev-reader-key,op:operator:dev-operator-key,ad:admin:dev-admin-key'
FATHOM_DEV_ECHO=1  FATHOM_HTTP_ADDR=127.0.0.1:8080  fathom.exe all
```

Startup log confirmed: store migrated, `worker started tasks:["echo"]`, scheduler,
`api listening addr:127.0.0.1:8080`, and — correctly — `relay not started: no
FATHOM_KAFKA_BROKERS`. That last line is why `/readyz` reports `relay_lag`: the
degraded state is real system behaviour, faithfully surfaced by the UI (§5).

Seed used for the browser pass: `scripts/phase6-seed.ps1` (registers two real
definitions as admin, creates two real instances as operator). It is a dev
reproduction aid; nothing from it is baked into the frontend.

---

## 2. Static gates (all run this session, after every fix)

| Gate | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc -b` | **clean (exit 0)** |
| Unit tests | `npm test` (vitest) | **6 files / 30 tests passed** |
| Lint | `npm run lint` | **0 errors, 9 warnings** |
| Production build | `npm run build` | **success, 329 ms** |
| Bundle | JS `570.65 kB` (gzip `175.44 kB`), CSS `69.00 kB` (gzip `15.23 kB`) | single chunk |

**9 lint warnings, all `react-refresh/only-export-components`** in `components/ui.tsx`
(6), `state/api.tsx` (1), `state/settings.tsx` (2): pure helpers (`fmtTime`,
`describeError`, hooks) share a file with components. They are a Fast-Refresh DX
notice, not correctness; they do not fail the gate. Recorded as an optional
later split. The **chunk-size (>500 kB) build message** is informational — the
cockpit is one authenticated bundle; code-splitting is a documented non-blocker.

---

## 3. Live browser validation (Chromium, admin key `ad · role admin`)

Real data observed end-to-end (workflow ids truncated for brevity):

| Workflow | business_key | Final state | Steps (from `GET /v1/workflows/{id}`) |
| --- | --- | --- | --- |
| `echo-single` | `demo-happy-1` | **COMPLETED** | `echo` → SUCCEEDED |
| `echo-compensate` | `demo-comp-1` | **ABORTED** | `echo` → **COMPENSATED**, `finalize` → **FAILED** |
| `loop-test` (pre-existing Phase-5 fixture) | `bk:01a16926…` | **FAILED_MANUAL** | `slow-retry` exhausted; produced a `DEADLINE` dead-letter |
| `echo-single` | `demo-ui-1` | **COMPLETED** | created **through the UI** (§6) |

Screen-by-screen verdicts:

| Screen | Verdict | Evidence |
| --- | --- | --- |
| Overview `/` | PASS | real census Total/Completed/Failed·Aborted/Manual; state bar `1 ABORTED / 1 COMPLETED / 1 FAILED_MANUAL`; DLQ depth `DEADLINE=1`; outbox backlog; degraded banner `readyz: unavailable (relay_lag)` |
| Workflows explorer | PASS | 3 rows correct; exact-match `business_key` filter works; empty filter now shows a proper empty state (see FIX-1) |
| Execution inspector | PASS | two-node graph `echo COMPENSATED` + `finalize FAILED` with dependency edge; node/rail selection populates Position/Attempts/Compensable/Compensator/Lease; all tabs render real rows |
| Dead-letter centre | PASS | one `DEADLINE` dead-letter for `loop-test`; dry-run preview + force-terminate/complete-compensation only; `retry-now` correctly NOT offered |
| Events & audit | PASS | per-workflow audit feed (WORKFLOW_CREATED→STEP_ISSUED→STEP_SUCCEEDED→WORKFLOW_COMPLETED with seq + trace ids) and inbound count |
| Metrics & health | PASS | 11 real `fathom_*` series; no fabricated sparklines/Δ% (G4); gauges bounded |
| Settings & diagnostics | PASS | key entry + role echo; three live probes; Definitions list (2 ACTIVE) + admin-gated register |

Console: **0 red errors** across both sessions. Only non-fatal notices: repeated
`React Flow … hiding the attribution` (see §8) and a transient
`parent container needs a width and a height` on graph mount (graph renders
correctly; see §8).

---

## 4. Signature workflow graph (§5 of the brief)

- Nodes are built from the real `workflow.steps[]` (`StepView`) ordered by
  `position`; edges connect consecutive steps only. The graph **never infers** a
  parallel/`depends_on` topology the backend does not serve — the wire schema is a
  sequential list, so the cockpit draws a sequential chain (honesty rule).
- Compensation is rendered as a **node state/attribute** (`COMPENSATED`,
  "rolling back", compensator-task chip), **not** an invented reverse vertex. The
  `echo-compensate` ABORTED run demonstrates the real COMPENSATED + FAILED pair.
- Node state, attempt badge (`active_attempt / max_attempts`), lease chip and
  deadlines come directly from `StepView`. Animated edges appear only where a
  downstream step actually advanced (`layout.ts` sets `animated` from real state).
- Keyboard: the parallel "Steps" rail is real `<button>`s with `aria-pressed`;
  Arrow/Home/End move focus and Enter/Space select (see FIX-4). Reduced-motion: the
  blanket `@media (prefers-reduced-motion: reduce)` rule in `tokens.css` collapses
  every transition/animation duration with `!important`, which also neutralises
  React Flow's own edge-dash animation.

---

## 5. Defects found by validation and fixed (before/after)

Each was surfaced by the real browser/HTTP pass, then fixed in the frontend only.

| ID | Defect (how found) | Fix | Verified |
| --- | --- | --- | --- |
| **FIX-0** | `CreateWorkflowModal` labelled `deadline` "optional" and omitted it when empty; the API **requires** a future RFC3339 deadline (`createWorkflow`: nil/past ⇒ 422). Contract bug caught by reading `handlers.go`. | Prefill `deadline = now + 1h`, mark required, send it unconditionally. | UI create reached COMPLETED (§6) |
| **FIX-1** | Any exact-match filter miss crashed the list: `GET /v1/workflows?business_key=<miss>` returns `{"items":null,"next_cursor":null}` (a Go nil slice marshals to `null`), and `vPage` rejected it as malformed → "Unexpected response shape". Confirmed at the wire level. | `guards.ts` `vPage` coerces `null`/absent `items` → `[]` (a non-array, non-null value still throws). Regression test added (`guards.test.ts`). | Empty filter now renders "Nothing matches these filters", no error |
| **FIX-2** | Settings readiness dot was **green** while its own text said `readyz: unavailable` — the dot keyed off `!isError`, but `/readyz` returns a *valid* 503 body. Untruthful status. | Derive the probe state from the parsed `Readyz.status` (added an amber `warn` state + `--fx-st-warn` token). | Row now amber with `readyz: unavailable · relay_lag`; Liveness/Metrics stay green |
| **FIX-3** | At 390 px the workflows `<table>` (≈760 px) pushed the whole document sideways (`documentElement.scrollWidth 773`), clipping Created/Updated. | `.fx-panel__body--flush` gets `overflow-x:auto; max-width:100%`, so wide tables scroll inside the panel. | 390 px: `scrollWidth 380 ≈ innerWidth`, all columns reachable inside the panel; no page-level overflow |
| **FIX-4** | Step rail labelled "keyboard accessible" but had no arrow/Home/End navigation (only Tab). | Added roving-focus key handling on the rail (`WorkflowDetail.tsx GraphTab`); hooks kept above the empty-state early return. | Arrow keys + Home/End move focus with a visible ring; Space/Enter select (Enter relies on native button activation) |

No backend code changed. All five fixes are frontend-only.

---

## 6. End-to-end create → execute → status (through the UI)

In the browser: opened the create modal, chose `echo-single @ v1 · 1 steps`,
business key `demo-ui-1`, input `{"note":"from-ui"}`, kept the prefilled future
deadline, submitted. The modal sent `POST /v1/workflows` with a client-generated
`Idempotency-Key`, navigated to the new instance, which advanced
QUEUED → RUNNING → **COMPLETED** in ~2 s (wall time ~157 ms). Its graph shows the
single `echo` node SUCCEEDED. This exercises definition→instance→worker(echo)→
final-status entirely through real API calls.

---

## 7. Honesty checks

- **No fixtures in production views.** Every number is a live read; dev echo is
  labelled a sample; the seed lives only in `scripts/`, isolated from `web/`.
- **Authz is enforced server-side, not by hiding buttons.** A reader key still sees
  the action controls; a write surfaces an honest 403 (`AuthError kind=forbidden`),
  and Settings shows an admin-required *warning* rather than silently hiding the
  register verb.
- **No embedded secrets.** The bearer key is entered at runtime and stored in
  `localStorage` only; nothing privileged is in source. Infra probes never receive
  the key.
- **Unavailable ≠ fake.** G1–G9 from the checklist are shown as bounded polling
  ("snapshot @ ts", never "live"), per-workflow events, no invented trends, and no
  abandon verb.

---

## 8. Known non-blocking issues

- React Flow attribution notice: `@xyflow/react` is MIT-licensed; `proOptions.
  hideAttribution` is available without a paid plan, so suppressing the badge is
  permitted — the console notice is a nag, not a licence violation. Revisit before
  any public release.
- Transient `[React Flow]: parent container needs a width and a height` on first
  graph mount; layout resolves immediately and the graph renders at both viewports.
- Mobile tab strip / top-bar search use horizontal scroll without a fade affordance
  (content is reachable, not clipped).

## 9. Backend follow-ups (recorded, NOT done here)

- `POST /v1/definitions` returns `created_at: 0001-01-01T00:00:00Z` while
  `GET /v1/definitions` returns the real timestamp — populate the field in the
  register response DTO for symmetry (UI relies on the list, so not blocking).
- Confirm the intended DLQ `class` enum (validation observed `DEADLINE`) is distinct
  from the event-classification vocabulary; document it so the class filter can offer
  exact values instead of free text.
- A real streaming seam (G1) and a global audit feed (G2) would let the cockpit drop
  polling and add a cross-workflow event ledger.

---

## 10. Status & stopping point

All seven required screens plus the signature graph are implemented, connected to the
real Phase-5 backend, and validated in a live browser at desktop and mobile sizes with
a working create→execute→status flow. Static gates are green (typecheck clean, 30 tests
pass, lint 0 errors, build succeeds). The cockpit is committed as a single local commit;
**Phase 6 stops here pending review** — no next phase, remote, push, or deploy without
authorisation.
