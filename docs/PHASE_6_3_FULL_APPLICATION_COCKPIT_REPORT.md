# PHASE 6.3 — NUNATAK FULL-APPLICATION PREMIUM COCKPIT REPORT

**Project:** Nunatak — Workflow Orchestration Cockpit
**Repository:** `E:\Projects\fathom-workflow`
**Baseline commit:** `f24bd16` (Phase 6.2)
**Scope:** Entire frontend (`web/`), shared design system, every route, reusable components, real-data visualizations.
**Mode:** Autonomous implementation + testing + visual validation + reporting.

---

## 1. Summary of the full-application transformation

Phase 6.3 did **not** rebuild the application. The audit (§1) confirmed a mature,
already-honest design system and real backend integration. This phase **elevated and
unified** that system so that all seven routes read as one premium operations cockpit:

- **One shared metric-card recipe** (`KpiCard`) now powers both the Overview command
  centre and the execution inspector. The inspector previously had its own inline KPI
  markup and the Overview had a separate lighter `StatCard`; both were collapsed into a
  single component with animated counts, status-tinted icons, a left accent bar, hover
  lift, caption row, and a staggered first reveal.
- **One staggered-entrance motion primitive** (`fx-rise` + `--fx-rise-i`) was introduced
  and applied to every dashboard/panel across Overview, Workflows, Events, Metrics,
  Settings, DLQ and the inspector. It runs **once on mount** and never replays on poll.
- **One stacked panel-header pattern** (eyebrow `kicker` above the title) replaced the
  previous inline header, fixing long monospace kickers colliding with titles app-wide.
- **Concrete visible defects were fixed with evidence**, not restyled blindly: the Dead
  Letter duplicate `DEADLINE` badges, the two ambiguous unlabeled "Preview" buttons, and
  the inspector event-log reason codes that broke mid-word.
- **Data honesty was preserved throughout.** No sparklines, rate curves, trend
  percentages, success-rate history, CPU/memory, or global event firehose were invented,
  because the backend does not expose the underlying data (gaps G2 / G4, §6). Degraded
  readiness is surfaced as-is; terminal workflows show disabled mutating actions.

The build, lint, and unit-test gates are all green (§10), and before/after screenshots of
every required route were captured and reviewed at the same desktop viewport (§7–§8).

---

## 2. Screens and components changed

Full diff: **11 files, +300 / −155**.

| File | Change |
| --- | --- |
| `web/src/components/ui.tsx` | Added `useCountUp(target, duration)` (rAF count tween, reduced-motion aware). Added shared `KpiCard`. Added optional `style` prop to `Panel`. Added `CSSProperties` / `StatusTone` imports. |
| `web/src/screens/Overview.tsx` | Replaced the local `StatCard` with the shared `KpiCard` (5 cards, animated + staggered). Switched `.fx-stats` → `.fx-kpi` grid. Added `rise()` helper and staggered the 5 content panels. Removed now-unused `StatusTone` / `ReactNode` imports. |
| `web/src/screens/WorkflowDetail.tsx` | Inspector `KpiStrip` refactored to reuse `KpiCard` (unifies the two KPI implementations). Event-log row markup: moved `.fx-log__code` out of `.fx-log__msg` to a full-width sibling so reason codes render whole. |
| `web/src/screens/Dlq.tsx` | Added unresolved/resolved summary strip. De-duplicated `reason_code` badge (only shown when it differs from `class`). Split actions into two labeled cards (Force terminate / Complete compensation), each with its own hint + Preview + action. Staggered cards. |
| `web/src/screens/Workflows.tsx` | Added `useNavigate`; rows are now click-to-inspect (`.fx-link-row`), with `CopyChip` wrapped in a `stopPropagation` span. Staggered the table panel. |
| `web/src/screens/Events.tsx` | Staggered the Scope panel and content/empty panels. |
| `web/src/screens/Metrics.tsx` | Added `rise()` helper; staggered the 7 panels. |
| `web/src/screens/Settings.tsx` | Staggered the 3 panels (API key, Connection, Definitions). |
| `web/src/screens/screens.css` | Removed the orphaned `.fx-stats`/`.fx-stat*` block (≈65 lines). Extended `.fx-kpi__card` grid-areas with an optional `"s s"` sub row + `.fx-kpi__sub`. Added DLQ summary / severity accent / action-set styles (+@780 responsive). Restructured `.fx-log__row` into a two-line grid with a full-width `code` area. |
| `web/src/theme/base.css` | `.panel-title` → stacked column (kicker above title) + `.kicker` line-height reset. Added `@keyframes fx-rise` + `.fx-rise` stagger utility. |
| `web/src/theme/tokens.css` | Reduced-motion blanket rule now also zeroes `animation-delay` and `transition-delay` (so stagger delays collapse for reduced-motion users). |

No screen was rewritten wholesale; each change is a targeted elevation of existing,
working code.

---

## 3. Shared design-system changes

- **Design tokens** (`theme/tokens.css`) were already centralized in Phase 6.1/6.2 (surfaces,
  status set `--fx-st-*`, gradients, motion durations/easings, layout dims, typography
  `--fx-font-display` / `--fx-font-ui` / `--fx-font-mono`). This phase kept that direction and
  removed **obsolete/duplicated styles** per §2: the entire `.fx-stats`/`.fx-stat*` family was
  deleted after `grep` confirmed zero remaining TSX usages, leaving `KpiCard` as the single
  metric-card source of truth.
- **Panel header** is now a reusable stacked pattern: eyebrow `kicker` on top, title below.
  This one change in `base.css` propagates consistent hierarchy to every `Panel` across all
  screens without touching individual screens.
- **`Panel` gained a `style` prop** so stagger indices (`--fx-rise-i`) can be passed cleanly
  without wrapper elements.

---

## 4. Animation and interaction inventory

| Interaction | Where | Behaviour | Motion constraint honoured |
| --- | --- | --- | --- |
| Staggered card/panel entrance | All dashboards & panels | `fx-rise` (opacity + 10px translateY), delay = index × 55ms | Runs once on mount; not replayed on poll |
| Animated KPI count | Overview + inspector `KpiCard` | `useCountUp` eases from previous value to new value on **real** change (cubic ease-out, 650ms) | First mount shows value directly (no fake count-from-zero); only animates when the value actually changes |
| Card hover lift | `KpiCard`, DLQ bar, activity rows | `translateY(-1px)` + border lightens (fast) | Restrained, non-decorative |
| Clickable workflow row | Workflows explorer | Cursor + navigate to `/workflows/:id` on click; CopyChip isolated via `stopPropagation` | — |
| Progress bar fill | Inspector graph panel | Width transitions on real value change | No animation for terminal workflows |
| Readiness / status | Overview header, banners | Existing state-driven; degraded shown honestly | No false-healthy |

**Reduced-motion:** the `tokens.css` blanket rule forces `animation-duration`,
`transition-duration`, `animation-delay`, and `transition-delay` to effectively 0, so
`fx-rise` and the stagger delays collapse. `useCountUp` additionally checks
`prefers-reduced-motion` and jumps straight to the target. Keyboard focus is unchanged and
fully preserved.

---

## 5. Charts and their exact data sources

Every visualization is data-driven from the real backend; none generate synthetic values.

| Visual | Screen | Exact source |
| --- | --- | --- |
| KPI numbers (Total / Completed / Active / Failed / Manual) | Overview | `fathom_workflows_total` census labels via `workflowCensus()` (`api/prom.ts`), computed from live scrape |
| State census (segmented bar) | Overview, Metrics | `fathom_workflows_total` by `state` label |
| Recent activity list | Overview | `GET /v1/workflows` (newest-first summary rows) |
| Ingress classification (bar list) | Overview, Metrics | `fathom_events_classified_total` by `class` |
| Dead-letter depth | Overview, Metrics | `fathom_dlq_depth` by `class` (+ `GET /v1/dlq` for the DLQ screen) |
| System pulse / ageing & backlog gauges | Overview, Metrics | `fathom_oldest_open_workflow_age_seconds`, `fathom_oldest_dlq_age_seconds`, `fathom_outbox_backlog`, `fathom_relay_publish_lag_seconds`, `fathom_step_leases` |
| Transitions distribution | Metrics | `fathom_workflow_transitions_total` by edge |
| Relay publish lag | Metrics | `fathom_relay_publish_lag_seconds` |
| Raw series table | Metrics | Every `fathom_*` sample in the scrape (ground truth) |
| Inspector KPI strip, steps, attempts, event log, audit | Inspector | Real per-workflow step/event/audit records from `GET /v1/workflows/:id` |

The scrape exposes **11 `fathom_*` series**. Metrics are **durable totals / current gauges
only** — there is no time-series history endpoint, so no sparkline or `rate(Δ)` curve is
drawn anywhere (see §6).

---

## 6. Backend data limitations and proposed follow-up

Honest gaps that constrain how far the visuals can go without fabricating data:

- **G2 — No global event stream.** The backend exposes events only **per workflow**. Events &
  Audit is scoped to a selected workflow with recent-workflow shortcuts; no cross-workflow
  "firehose" is invented. First-use state explains how to select a workflow.
- **G4 — No time-series history.** `/metrics` is a single Prometheus scrape of durable
  counters and current gauges. There is no historical series endpoint, so the §4 "sparkline
  only when real samples exist" and §9 "elegant line/area charts" cannot be truthfully
  satisfied. Overview KPI cards therefore use tasteful static accents + genuine current
  values (with count-up on real change), and Metrics shows distributions/gauges plus the raw
  scrape rather than curves.
- **No CPU / memory / worker-utilization / success-rate history** is exposed, so none is
  displayed (§9 compliance).

**Proposed backend follow-up (smallest justified contract, NOT implemented here to respect
§15):** a read-only `GET /v1/metrics/series?name=<metric>&window=<range>&step=<interval>`
returning `{ t, v }[]` for a allow-listed set of `fathom_*` counters would unlock honest
sparklines/rate curves on Overview KPI cards and Metrics line charts. Until then the
"unavailable" state is preserved instead of simulated.

---

## 7. Before/after screenshots for all required routes

Screenshots were captured by driving the live app (Vite `localhost:5173`, backend `:8080`,
`Authorization: Bearer dev-admin-key` admin key) at a **1526 px desktop viewport** (see §9
limitation) with real fixture data: **6 workflows** (COMPLETED ×3, ABORTED ×2, FAILED_MANUAL
×1), **2 definitions**, **1 DLQ item**, readyz `unavailable / relay_lag`.

Captured to `.artifacts/baseline63/` (before) and `.artifacts/after63/` (after). PNG binaries
are retained locally as evidence but are **not committed** (§19: generated artifacts kept out
of the repo). Concrete before→after differences per route:

1. **Overview** *(most important)* — Before: KPI row used the smaller lighter `.fx-stat`
   tiles; inline panel titles. After: five inspector-grade `KpiCard`s with ~30px display
   numerals, colored left accent bars, icon chips, caption rows, staggered reveal; stacked
   eyebrow-over-title headers; the long kicker "Ingress classification" now fits one line.
2. **Workflows** — Before: non-clickable rows. After: click-a-row-to-inspect with pointer
   cursor, CopyChip isolated from navigation, staggered table entrance. Search/filter/
   pagination semantics unchanged (exact-match only, honest).
3. **Inspector — completed workflow** — Before: inline duplicated KPI markup; event-log
   reason codes broke mid-word. After: unified `KpiCard` strip; reason codes render whole on
   their own full-width line (verified ~109px used of ~252px column). Terminal state shows
   Cancel/Retry **disabled** (honest).
4. **Inspector — aborted/compensated** — Same KPI unification and event-log fix; compensation
   relationships and terminal immutability preserved from Phase 6.2.
5. **Dead Letter** — Before: duplicate `DEADLINE` badges + two unlabeled "Preview" buttons.
   After: single de-duplicated badge, an unresolved/resolved summary strip, coral left-edge
   severity accent on open incidents, and two **labeled** action cards (Force terminate /
   Complete compensation) each with hint + own Preview + confirm. No mutation fires on click.
6. **Events & Audit** — After: staggered Scope + content/empty panels; still per-workflow
   scoped (no fabricated global stream).
7. **Metrics & Health** — After: staggered 7 panels; distributions, gauges, and the exhaustive
   raw-series table; no invented curves. *(Note: hard-loading `/metrics` returns raw Prometheus
   text via the Vite proxy; the SPA renders on client-side navigation — see §11.)*
8. **Settings** — After: staggered API-key / Connection-probe / Definitions panels; keys stay
   sensitive; session storage + server role enforcement unchanged.

---

## 8. Screenshot-based acceptance checklist

Reviewed from the actual rendered after-images (not DOM/CSS alone):

| Check | Result |
| --- | --- |
| Correct visual hierarchy (eyebrow → title → value) | ✅ all routes |
| Consistent typography (display numerals, mono IDs/logs) | ✅ |
| Consistent colors/surfaces across screens | ✅ |
| Refined spacing & aligned panel proportions | ✅ |
| Meaningful, real data visualization | ✅ |
| Appropriate, restrained motion (stagger once, count on change) | ✅ |
| Correct real data (census, DLQ, probes) | ✅ |
| Degraded/error/empty states honest (readyz unavailable, no-scope) | ✅ |
| No layout overflow at captured width | ✅ |
| No nonfunctional decorative controls | ✅ |
| DLQ duplicate-badge + ambiguous-button defects resolved | ✅ |
| Inspector event-log mid-word break resolved | ✅ |

---

## 9. Accessibility and responsive validation

- **Accessibility:** `KpiCard` icon is `aria-hidden`; the numeric value is real text; the DLQ
  summary uses `role="status"`; event-log uses semantic row markup; focus rings and keyboard
  navigation preserved (row click adds to, not replaces, the existing `Link`). Color contrast
  unchanged from the established token set. Reduced-motion fully honoured (§4).
- **Responsive:** Existing breakpoints (1240 / 900 / 780 / 560 / 520) are preserved and
  extended — the new `.fx-dlq-actionset` collapses to a single column ≤780px; `.fx-kpi` already
  stepped 5→3 columns ≤1240px and stacks further at narrow widths; inspector side panel and
  lower ops grid stack via existing rules.
- **Viewport limitation (honest):** the browser tooling could not resize the window below
  ~1526 px, so true 1280 / 1024 / 768 / 390 screenshots were **not** captured. These layouts
  rest on the preserved/extended responsive CSS rather than on fresh pixel evidence — I am
  explicitly **not** labelling them as visually verified.

---

## 10. Test, lint and build results

Authoritative gates (from `web/`):

- **Build** (`npm run build` = `tsc -b && vite build`, the authoritative type-check that does
  NOT emit stray `.js` into `src/`): ✅ `built in 248ms`, 253 modules. (Pre-existing single-
  bundle chunk-size advisory only, unchanged by this phase.)
- **Lint** (`npm run lint` = `eslint .`): ✅ **0 errors**, **10 warnings** — every warning is
  the pre-existing `react-refresh/only-export-components` pattern (ui.tsx, api.tsx,
  settings.tsx). The +1 ui.tsx warning is `useCountUp`, the same already-present class for a
  file that exports both components and hooks; no new error class introduced.
- **Tests** (`npm run test` = `vitest run`): ✅ **30/30 passed** across 6 files (prom, status,
  settings, guards, graph layout, ui).

Fixed defects introduced during this phase (evidence of clean-up):
- A transient `react-hooks/set-state-in-effect` **error** from a synchronous `setDisplay` in
  `useCountUp`'s reduced-motion branch — resolved by keeping all state updates inside the
  async `requestAnimationFrame` tick.
- A transient Metrics edit that clobbered the `fmtVal` signature — restored.

---

## 11. Remaining gaps or blocked items

- **G2 / G4 data gaps** (§6) cap the visualization ambition; the concrete backend contract to
  unblock sparklines/time-series is documented but intentionally not implemented (§15).
- **True mobile/tablet screenshots** not captured (tooling min ~1526 px, §9).
- **`/metrics` hard-load** returns raw Prometheus text via the Vite proxy (SPA renders via
  client-side nav) — an environment/proxy behaviour, not a frontend defect.
- **Pre-existing cosmetic items left untouched** to avoid regressing Phase 6.2 graph code with
  no screenshot evidence to verify a fix at available viewports: the "rolling back" node-label
  wrap in the graph, minor census-panel dead space, and clipped long placeholders. These are
  noted honestly rather than risked blind.

---

## 12. Git commit and final working-tree status

- Work confined to `E:\Projects\fathom-workflow` (branch `main`, baseline `f24bd16`). All
  prior commits preserved.
- **No remote, no push, no deploy** (§19).
- The screenshot binaries in `.artifacts/` are **gitignored** so they are not committed
  alongside the source changes.
- This phase produces **exactly one local commit** covering the 11 source-file changes,
  the `.gitignore` update, and this report. Phase 7 is **not** started.

**Final status:**

- **One** local commit: "Phase 6.3: full-application premium cockpit transformation"
  (13 files changed: 11 source + `.gitignore` + this report), directly on top of the
  `f24bd16` baseline on branch `main`. (A commit cannot embed its own hash; verify the
  exact SHA with `git log -1`.)
- Author/committer: `Lakhyajit Changmai <lakhya911@gmail.com>` (set per-commit via
  `git -c`, no global/local config modified).
- Working tree after commit: **clean** (`git status` empty). `.artifacts/` screenshot
  evidence is gitignored and remains untracked.
- No remote configured, nothing pushed or deployed.
