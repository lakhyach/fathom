# Phase 6.1 — Visual Redesign & Inspiration-Matching Report

Executed: 2026-10-23. Companion to `ASSET_ATTRIBUTION.md` (asset/licence trail)
and `PHASE_6_VALIDATION_REPORT.md` (the Phase 6 baseline this pass builds on).

This pass is a **presentation-layer visual redesign** of the workflow-operations
cockpit: rebrand, bespoke logo/favicon, alpine sidebar artwork, premium typography
and centralised tokens, a reference-matching **execution inspector**, an Overview
redesign, motion/polish, and responsive fixes — followed by a real-browser
validation against the **live backend**.

Hard boundaries honoured throughout:
- No backend semantics were changed to satisfy the UI. No metric was invented.
- No remote, push, deploy, domain purchase, or public exposure was performed.
- Work confined to `E:\Projects\fathom-workflow`. All prior commits preserved.
- One local commit at the end, only after gates + full-diff review. Then STOP
  (no Phase 7 work begun).

Baseline at start: `20a1e5c` (Phase 6), branch `main`, clean tree, **no remote**.

---

## 1. Static gates (re-run after every change)

| Gate | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc -b` | **clean (exit 0)** |
| Unit tests | `npx vitest run` | **6 files / 30 tests passed** |
| Lint | `npx eslint .` | **0 errors, 9 warnings** (all pre-existing `react-refresh` / `exhaustive-deps` notices) |
| Production build | `npm run build` | **success (~240 ms)** |
| Bundle | JS ≈ `581 kB` (gzip ≈ `178 kB`), CSS ≈ `78.8 kB` (gzip ≈ `16.5 kB`) | single authenticated chunk |

New dependency added this pass: `@fontsource-variable/space-grotesk@^5.3.0`
(OFL) — a bundled display font, no runtime fetch. No motion library was added
(see §7). The `npm install` advisory reported 3 **dev-only** advisories in the
test toolchain (1 moderate in `@vitest/mocker`, 2 critical in `tinypool`); these
are transitive to `vitest`/`vite` **at build/test time only**, are not present in
the shipped browser bundle, and were **not introduced by this pass** (they exist
on the Phase 6 baseline). Forcing `vitest@5` would be a breaking change out of
scope for a visual pass; recorded as a known item.

## 2. Brand rename — evidence and decision (§2)

"Fathom" collides heavily across the target space (fathom.ai analytics,
usefathom.com LMS, a cryptocurrency of the same name, multiple GitHub projects),
so the visible name was changed. Candidates were screened for competing
workflow/dev-tools/SaaS products and their domains:

| Candidate | Blocker found |
| --- | --- |
| Cairn | active news/product collision |
| Halyard | existing Spinnaker CI/CD tool |
| Lodestone / Moraine | developer-tool collisions |
| Aiguille | clean, but obscure/hard to pronounce |
| **Nunatak** | **clean of competing dev/workflow products** (only unrelated VC/consulting); alpine metaphor matches the sidebar artwork and the peak-as-graph logo; easy to pronounce |

Selected **Nunatak**. Applied as a presentation-layer rename only: visible name,
page title, nav, `NunatakClient`, dev-facing copy. Module path, binary name,
`fathom_*` metric series and the localStorage key were **intentionally left as
`fathom`** (rationale in `ASSET_ATTRIBUTION.md` §5). No legal clearance is
claimed and no trademark search beyond product/domain screening was performed.

## 3. Assets (§3–§5) — see `ASSET_ATTRIBUTION.md`

- **Logo/favicon:** original `nunatak.svg` (peak-as-graph mark) wired into the
  rail, the browser tab and the loading icon; crisp at 16/32/48 px.
- **Sidebar artwork:** original layered `alpine.svg`, anchored to the rail base,
  with a scrim gradient overlay that keeps the nav fully readable. Documented
  deviation: authored as owned vector rather than downloading a licensed photo
  (tooling forbids binary downloads; keeps the licence chain clean, tiny, crisp).
- **Typography:** Space Grotesk (display) + Inter (UI) + JetBrains Mono (numerals),
  all self-hosted via Fontsource, bundled into `dist/assets`. Verified in the
  network log as same-origin `.woff2` loads with **zero external font hosts**.

## 4. Execution inspector — reference composition mapping (§6)

The reference image is an execution-inspector; it was rebuilt as the dedicated
`WorkflowDetail` surface (`web/src/screens/WorkflowDetail.tsx`) laid out to the
brief's composition A–G, with every value traced to a real `Workflow`/`StepView`/
audit/`/metrics` fact.

| Brief element | Status | Notes / honest deviations |
| --- | --- | --- |
| A · Global shell (narrow rail, brand, custom icons, gradient active route, mountain art, bottom engine-status card, refined top bar) | **PASS** | Rail shows a **real** engine card (readyz + `fathom_worker_leases_held`) and a **real** role chip from the presented key. No fake bell / account menu / theme toggle. Search routes only by UUID or exact business key (placeholder reworded to match). |
| B · Execution header (breadcrumb, real id, name/version, status pill, started/elapsed, supported controls only) | **PASS** | Elapsed anchored to the query snapshot timestamp (not `Date.now()`), so it is render-stable and advances one poll at a time. No invented name/priority/timestamps. |
| C · KPI strip (5 real counts, no invented trends) | **PASS** | Census from `fathom_workflows_total`. **No sparklines** — time-series does not exist (gap G4), so none are drawn. |
| D · Main graph (dark dotted canvas, custom nodes, curved connectors, state-driven colour, controlled glow, progress bar, keyboard node selection, NO invented branching DAG) | **PASS** | Sequential chain only (position order + compensator attributes). Connectors are coloured by each target step's real status tone; edges animate only once the downstream step has actually begun. Progress bar = succeeded steps / total. Keyboard step rail with roving focus is the accessible equivalent of the (decorative) canvas. |
| E · Right details panel (real fields, JSON action only if real, long-id handling) | **PASS** | ID is a copy chip that yields the full UUID; breadcrumb exposes the full id via `title`. |
| F · Tab strip (Flow / Steps / Events / Attempts / Input·Output / Audit / Traces) | **PASS** | Every tab shows real content or states plainly that the backend does not expose it. |
| G · Lower panels (selected step, event log, engine/metrics health, DLQ) | **PARTIAL** | Step details, a real audit-derived event log, and execution metrics render. **Host CPU/memory/DB telemetry is intentionally absent** — the engine does not expose it; the panel says so rather than simulating. Traces tab shows only real stamped `trace_id`s (no distributed-trace backend, gap G7). |

**Colour-hue note:** the reference paints "running" in blue/cyan; this product's
established status system (Phase 6) encodes running as amber and reserves the
blue→violet ramp for interaction/brand. The inspector stays internally consistent
with the app's own tokens rather than re-matching the reference's hues — colour
never travels alone (every tone co-renders a text badge).

## 5. Overview redesign (§7)

Rebuilt in the same language. The key integrity change: **readiness can never
misreport healthy.** A dedicated pill (`fx-health`) and, when not ready, a
full-width alert banner now drive strictly from `/readyz`:
- genuine `status === "ready"` → teal "Ready";
- `unavailable` → red "Degraded · <reason>" (db_unavailable / relay_lag);
- fetch **error** (unreachable) → rose "Control plane unreachable";
- in-flight → neutral "Checking readiness".

A live degraded run is exactly the observed state (see §6). Proportions, census
visualisation, recent activity, ingress/DLQ bars and the system-pulse gauges were
kept honest (nulls show `—`, never 0).

## 6. Live-browser validation (§13)

Real stack, no mocks:

| Fact | Value |
| --- | --- |
| Postgres | docker `fathom-pg17`, `127.0.0.1:5434`, db `fathom_test`, migrations applied |
| Backend | `bin/fathom.exe all` (existing binary; backend unchanged this pass) with dev DSN/keys/echo (obviously-fake loopback values) |
| Frontend | `npm run dev` → http://localhost:5173, proxy forwards `/v1`,`/healthz`,`/readyz`,`/metrics` to `:8080` |
| Seed | Two real definitions (`echo-single`, `echo-compensate`) + real instances, producing **COMPLETED**, **ABORTED (compensated)** and **FAILED_MANUAL** workflows with genuine step data |
| Key | presented `ad:admin:dev-admin-key` in-app; role chip shows **Admin** |

Observed `/readyz` → **503 `{"status":"unavailable","reason":"relay_lag"}`** (the
`all` run had no Kafka broker). The UI faithfully showed **Degraded**, never
healthy — a positive integrity result, not a defect.

Screenshots captured (Chromium, exact CSS viewports 1440×900 and 390×844):
Overview desktop + scrolled, Inspector COMPLETED / ABORTED / FAILED_MANUAL
(incl. node-selected step panel and the Attempts tab), Overview mobile, Inspector
mobile, and the mobile nav drawer with the mountain artwork. Files live in the
validation tooling's `.artifacts/` folder (`A_*`, `B*`, `C*`, `D*`, `E*`, `F*`,
`G_settings_*`, plus `reval_*` mobile re-checks). They are validation captures,
not shipped product assets, so they are **not committed** into the repository.

**Visual-difference checklist vs the reference (this pass):**

| Area | Result |
| --- | --- |
| Sidebar brand + mountain artwork + engine card + role chip | PASS |
| Inspector header / KPI census / graph / details rail / tabs / lower panels | PASS (G = PARTIAL, telemetry intentionally absent) |
| Premium typography (display + mono), centralised tokens | PASS |
| Bespoke logo/favicon crisp at small sizes | PASS |
| Overview readiness integrity + census viz + activity + pulse | PASS |
| Responsive desktop→tablet→mobile (1440 / 1024 / 768 / 390) | PASS after fixes |

**Defects found by the live pass and fixed:**
1. **CSS cascade regression** — the inspector base rules (`.fx-insp-grid`,
   `.fx-kpi`, `.fx-insp-side`, `.fx-lower`) sat at the *end* of `screens.css`, so
   the responsive `@media` blocks placed earlier were beaten at every width; the
   mobile inspector collapsed to a 0 px main column. Fixed by moving all inspector
   breakpoints to the end (source order wins where specificity ties). Re-verified:
   at 390 px the grid/main/graphpanel/tabs are full width and panels stack.
2. **`Date.now()` in render** (3 lint errors) — replaced with the query snapshot
   timestamp for elapsed/deadline (deterministic per render).
3. **Mobile a11y** — icon-only "New workflow" now carries `aria-label`.
4. **Long-id recoverability** — details-rail ID is a copy chip (full UUID);
   breadcrumb exposes the full id via `title`.
5. **Broken dev hint** — the rail's offline hint said `nunatak control` (a
   nonexistent command); corrected to the literal `fathom control`.

**Post-fix re-validation:** 0 console errors (only the expected React Flow
"attribution hidden" notice); no 4xx/5xx except the intended `/readyz` 503; no
broken images/fonts; no horizontal document overflow at 390 px; KPI strip verified
at 2/3/5 tracks across 390/1000/1440.

## 7. Motion, charts, dependency discipline (§8–§11)

- **Motion is CSS-driven only.** Route/card entrances (`fx-fade-up`), KPI hover
  lift, node-selection glow, state-backed animated edges, progress-fill and
  tab transitions. A motion library (Framer Motion) was **evaluated and not
  added** — CSS already covers every required effect, and §11 favours not adding
  a runtime dependency for effects CSS can do. The global
  `prefers-reduced-motion` rule in `tokens.css` collapses all durations, so the
  graph edge animation and every entrance honour it with no JS gate.
- **Charts** remain the hand-built SVG primitives (`StateStack`, `BarList`,
  `GaugeRing`, `TransitionBars`) — no chart library added. They already expose
  `title` tooltips, `role="img"` + `aria-label` text alternatives, units, and
  honest empty states; missing series render as `—`/empty, never 0.
- **Reused** the existing React 19 / TS / Vite / router / API client / React Flow
  stack; the only new package is the bundled font.

## 8. Integrity statement (§12)

Every screen reads the real backend. No hardcoded metrics, no fabricated activity,
no decorative controls, no invented DAG branches, no simulated success animations,
no weakened authz, no embedded credentials. Where the engine does not expose a
capability (per-step outputs, host telemetry, distributed traces, pause/priority,
SSE), the UI **disables or explains** it and the gap is recorded here and in
`ASSET_ATTRIBUTION.md`. A degraded `/readyz` is shown as degraded.

## 9. Known items carried forward (non-blocking)
- Single bundle > 500 kB (React Flow + React Query). Informational; code-splitting
  is a documented non-blocker.
- 9 lint warnings (`react-refresh/only-export-components`, one `exhaustive-deps`) —
  DX notices, do not fail the gate.
- 3 dev-only npm advisories in the vitest/tinypool toolchain (not shipped, not
  introduced this pass).
- Reference-hue mismatch on "running" (amber by design vs the image's cyan) —
  deliberate consistency with the product's own status system.

## 10. Stop condition
Phase 6.1 is complete: gates green, live-browser validation done at desktop and
mobile, defects fixed and re-verified, docs written, one local commit created.
**No Phase 7 work was begun** and nothing was pushed, deployed, or published.
