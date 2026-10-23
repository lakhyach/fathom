# PHASE 6.5 — Nunatak Dream Cockpit: Full Visual Rebuild

**Scope:** transform the entire Nunatak workflow-orchestration cockpit into a premium,
cinematic operations surface, verified in a real browser with before/after evidence at
five viewports. This phase is a corrective to the honest finding that PHASE 6.4's
command palette + Motion integration, while useful, did **not** by themselves deliver the
visual transformation the reference image describes.

**Method:** re-examine the actual running app (not the build log), capture a real
before-matrix, apply a coherent art-direction layer + the highest-value route redesigns,
re-capture the after-matrix, and gate on build/lint/test/console/network. Where the whole
cockpit could not be re-sculpted in one pass, the highest-value end-to-end slice was
finished and the remaining route-by-route gaps are documented rather than declared done.

---

## 1. Executive result

| Gate | Result |
|---|---|
| `npm run build` (`tsc -b && vite build`) | ✓ pass — 729 modules, JS 780.72 kB / gzip 242.97 kB, CSS 89.59 kB |
| `npm run lint` | ✓ 0 errors, 10 warnings (all pre-existing `react-refresh/only-export-components`) |
| `npx vitest run` | ✓ 34/34 tests, 7 files |
| Horizontal overflow (8 routes × 5 viewports) | ✓ none |
| New console error classes | ✓ none (only the two pre-existing React Flow logs) |
| New network failure classes | ✓ none (same ERR_ABORTED / 503 / 429 as baseline) |

Bundle delta: **+1.76 kB JS / +0.06 kB CSS** vs the PHASE 6.4 baseline — the hand-built
donut. No new dependency was installed (§4 anti-bloat rule respected).

---

## 2. Re-examination & route-by-route gap analysis

The app was inspected live (real authenticated data) at 1536/1280/1024/768/390. It is a
**mature, coherent, bespoke dark cockpit** — not a generic template — but it did not yet
read "cinematic premium." Concrete, evidence-backed gaps:

| Route | Gap found in the before-matrix | Status this phase |
|---|---|---|
| **Overview** | `State census` panel was a thin stacked bar stretched inside a tall panel, leaving ~50% dead space beside the tall Recent-activity list; KPI surfaces read flat (barely lift off page). | **Fixed end-to-end** — donut census + tone-lit KPI cards. |
| **Execution inspector** | Graph canvas short (216 px) so the node(s) sat in a large flat field; not yet a "centrepiece." | **Fixed** — taller stage (288 px) + centre stage-light vignette; nodes frame better. |
| **Workflows (explorer)** | Solid; only the global atmosphere lift applied. | Lifted by shared layer; no route-specific rework. |
| **Dead Letter** | Solid investigation surface from prior phases. | Lifted by shared layer; **route-specific polish deferred**. |
| **Events & Audit** | Solid filterable explorer. | Lifted by shared layer; **route-specific polish deferred**. |
| **Metrics & Health** | Solid, data-honest telemetry. | Lifted by shared layer; **route-specific polish deferred**. |
| **Settings** | Solid, minimal. | Lifted by shared layer; **route-specific polish deferred**. |

The grids already used `align-items: start`, so the Overview void was a **short panel
beside a tall one**, not stretch — which is why the fix was a richer census visual that
consumes the column, not an alignment change.

---

## 3. Real-browser execution & restrictions

- **Connected browser (browser-use MCP):** used to navigate the live app, set auth via
  `evaluate_script`, and capture `base-overview.png`. It has **no viewport-resize tool**,
  so it cannot produce the 5-viewport matrix.
- **Documented alternative (per §3):** a deterministic **Chrome DevTools Protocol**
  harness (`.artifacts/capture.mjs`) driving a throwaway headless Chrome on :9222
  produced the full 8-route × 5-viewport before/after matrix (80 screenshots total) plus
  console + network + overflow evidence. This is the sanctioned fallback, not a claim that
  the connected browser did the resize.
- **Restrictions recorded:** Computer Use / connected-browser URL policy blocked
  arbitrary foreground-tab automation in prior phases; the isolated CDP profile sidesteps
  touching the user's real browser or exposing credentials. No unrelated tabs were
  touched; auth used the dev admin key only.

---

## 4. Design resources / libraries decision

Per the "do not add a competing design system for a few components; do not install to
inflate dependencies" rule, **no package was added**. The existing bespoke token set
(oklch surfaces, status set, gradients/glows already defined in `tokens.css`) plus the
hand-built SVG chart primitives already cover the need — the transformation is the
*application and composition* of that system, not new tooling. Tailwind / shadcn /
Recharts / TanStack Table / lucide / Geist were deliberately **not** introduced.

**Marketplace MCP note:** no external design-system MCP was required or invoked this
phase; nothing was blocked on manual marketplace authorization, purchase, or API key.

---

## 5. Art-direction layer (applies to every route)

- `theme/base.css` — richer atmospheric body field: a third, centred cool haze layered
  under the existing navy washes so the app reads as depth, not a flat dark page
  (contrast of content unchanged).
- `theme/base.css` — `.panel` gains a subtle top-edge sheen + slightly stronger inner
  highlight for surface separation.
- `screens/screens.css` — KPI cards refactored to a **tone-driven custom-property model**
  (`--fx-kpi-accent` / `--fx-kpi-glow`): a tone-tinted radial glow in the corner, a
  gradient icon chip with an inset accent glow, a brighter accent bar, and a lift +
  `--fx-shadow-md` on hover. Covers neutral/completed/running/negative/manual and adds
  compensating/warn.

## 6. Route redesigns (highest-value slice)

- **Overview census → donut** (`components/charts.tsx` `Donut`, `components/charts.css`):
  an SVG ring drawn from the same durable `fathom_workflows_total` data, with the total in
  the centre and a legend of per-state rows (dot · label · share % · count). Fills the
  former dead-space column with an honest, premium visual. `Overview.tsx` now renders
  `<Donut>` instead of the thin `StateStack`.
- **Inspector graph stage** (`graph/graph.css`): canvas height 216 → 288 px (190 → 232 on
  ≤780) with a centred blue "stage-light" radial so nodes sit on an intentional field.
  `fitView` framing and the animated compensation edge are unchanged and now read larger.

## 7. Motion & §8 functionality (preserved, verified)

No behaviour was altered. The existing motion is retained and confirmed non-disruptive:
`fx-rise` stagger runs once on mount (keyed, never replays on poll), `useCountUp`
animates only on real value change, running nodes pulse, React Flow edges animate — all
collapsed to ~0 under `prefers-reduced-motion` by the blanket rule in `tokens.css`.
Every control remains wired to the real backend (auth + server-authoritative state
untouched); no mock data was introduced.

---

## 8. Backend data gaps honoured (no fabrication)

- **G4** — no time-series history exists, so the donut shows a *current census*, not a
  trend; no sparklines were invented.
- **G2/G7** — no global event stream / distributed-trace backend; those tabs stay honest.
- Host CPU/memory/worker-utilisation telemetry is not exposed by the engine and remains
  explicitly absent (the inspector says so plainly).
- `readyz` genuinely returns **503 · relay_lag** in this environment; the UI renders it as
  a first-class degraded fact (banner + pill), never as healthy.

---

## 9. Evidence

- Before matrix: `.artifacts/p65/base-*@{1536,1280,1024,768,390}.png` (40 shots) +
  `base-_evidence.json`.
- After matrix: `.artifacts/p65/after-*@{...}.png` (40 shots) + `after-_evidence.json`.
- Verifiable improvements: Overview census void eliminated (donut fills the column), KPI
  cards carry tone glow on desktop and mobile, inspector graph is a taller lit stage with
  well-framed nodes and the visible echo→finalize compensation edge.
- Console (after): 24 entries = React Flow #004 transient sizing (15×) + attribution-hidden
  MIT log (9×) — both pre-existing, no new classes. Network (after): 187 ERR_ABORTED
  (in-flight polls aborted by rapid scripted navigation), 36× HTTP 503 (real degraded
  `readyz`), 22× HTTP 429 (backend rate-limiting the 40-shot burst) — all benign/expected.

**Licensing note (honest):** React Flow's attribution is hidden via
`proOptions.hideAttribution`; the library logs this. This is permitted under its MIT
licence and is pre-existing behaviour, recorded here rather than left silent.

---

## 10. Remaining route-by-route gaps (not declared finished)

The following still deserve a dedicated art pass in a future pass; they were lifted by the
shared layer but not individually re-sculpted this phase:

- **Dead Letter** — richer investigation affordances (row expansion, resolve flow emphasis).
- **Events & Audit** — denser timeline typography / event-kind colour coding.
- **Metrics & Health** — a stronger telemetry hero within the data-honesty limits.
- **Settings** — surface grouping polish.
- **Overview bottom row** — Ingress / Dead-letter panels still leave some void when their
  bar lists are short (2 rows / 1 row); a min-height or a secondary stat would close it.

Per the acceptance condition, the highest-value end-to-end slice (Overview + Inspector +
shared art direction) was completed and validated across all five viewports, and the
remaining routes are documented above rather than reported as done.

---

## 11. Files changed

- `web/src/theme/base.css` — atmosphere + panel depth
- `web/src/screens/screens.css` — KPI tone-glow model
- `web/src/components/charts.tsx` — new `Donut`
- `web/src/components/charts.css` — donut styles
- `web/src/screens/Overview.tsx` — census → `Donut`
- `web/src/graph/graph.css` — taller lit graph stage

Committed locally; **not pushed, not deployed, no paid assets**.
