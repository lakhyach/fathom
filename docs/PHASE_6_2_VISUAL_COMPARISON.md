# Phase 6.2 — Reference-Locked Visual Fidelity Comparison

**Project:** Nunatak (formerly Fathom) · **Repo:** this repository
**Baseline commit:** `1fc3c55` · **Reviewed:** 2026-10-23
**Design target:** the supplied premium workflow-execution cockpit reference
("Fathom · Order Processing", 1536 × 1024).

This document records the *evidence-first* comparison required by §8/§9. Every
verdict below is grounded in an actual browser screenshot of the running app
against the real backend — not in build output, CSS inspection, or a page load.

---

## 1. Method & honest capture constraints

| Concern | Reality |
| --- | --- |
| Reference viewport | 1536 × 1024 (the supplied PNG). |
| §1 "before" baseline | 1536 × 816 — the browser window at capture time was height-limited to 816 px, so the before shots are shorter than the reference. Files: `baseline_1536x816_abort_full.png`, `baseline_1536x816_completed_top.png`. |
| §8 "after" captures | 1920 × 1020 viewport (full-page inspector 1906 × 1525 / 1478). Files: `p62_*.png`. |
| Viewport-width mismatch | The after shots are **wider** (1920) than the reference (1536). This is disclosed rather than hidden. The layout is fluid and was visually confirmed to hold the same composition at both widths: the KPI strip stays 5-across and the wide-graph / narrow-details two-column split is preserved. A pixel-exact same-width overlay was therefore **not** produced; the comparison below is a structural/hierarchical side-by-side, which is what the brief's categories actually measure. No numerical similarity score is claimed. |
| Genuine mobile | The browser tooling in this session could not resize the viewport below ~1526 px, so `p62_inspect_mobile.png` is **not** a valid mobile capture (it is 1906 px wide) and is excluded from the responsive verdict. Responsive behaviour is instead evidenced by the earlier genuine 390 × 844 captures (`F_inspector_mobile_390x844.png`, `reval_M2_390x844_inspector_graph_tabs.png`, `reval_M3_390x844_lower_panels_stacked.png`) plus the CSS breakpoints at 1240 / 780 / 520 px. |
| Backend state | Live `fathom` engine on `:8080`; `readyz` reports `relay_lag`, so the UI honestly shows an "Engine degraded" banner. This is a real backend condition, not a visual defect. |

Screenshots referenced live in the local review artifacts folder
(`.artifacts/`); they are deliberately **not** committed into the repo.

---

## 2. Before → after (execution inspector, aborted/compensated workflow)

The reference's defining screen is the full execution inspector. Comparing the
§1 baseline against the §8 result on the *same* real workflow
(`echo-compensate`, id `01a169e6-43f3-7d7f-97a0-df4d977e4bfc`, echo COMPENSATED →
finalize FAILED):

| Element | Before (`1fc3c55`) | After (Phase 6.2) |
| --- | --- | --- |
| Step nodes | Rectangles with a coloured **left accent bar** + numeric badge; sparse, clustered centre-left with large horizontal dead space. | Compact **icon-circle** nodes (✓ / ✗ glyph per state) with status pill, attempt count and a "rolling back" annotation; enlarged to fill ~68 % of canvas width. |
| Connectors | Straight dashed segment, no head. | Curved bezier with an **ArrowClosed** head, tone-tinted stroke. |
| KPI cards | Icon sits left of a modest number. | Label on top, **large display-font number**, status icon moved to the corner — stronger numeric hierarchy. |
| Exec header | Title + badge only. | Adds a **tone-tinted circular status sigil** that mirrors the node glyphs. |
| Step-details panel | **Empty** ("No step selected"). | **Auto-selects the current step** so the panel opens populated. |
| Execution metrics | Vertical label/value list. | Compact **metric tiles** (Steps · Attempts issued · Compensable · Wall time · Deadline). |
| Dead-letter summary | Absent. | Full-width **"Related dead letter / manual interventions"** footer bar with live count. |
| Sidebar artwork | Three-ridge schematic. | **Cinematic four-plane layered range** with fog, rim light, snow caps, base fade. |
| Logo | Plain peak mark. | **Orchestration glyph** — diamond of nodes wired to a hollow central core. |

---

## 3. Thirteen-category comparison table

PASS = visibly matches the reference's intent and composition. PARTIAL =
matches structurally but with a deliberate, honest gap. FAIL = not achieved.

| # | Category | Verdict | Evidence & explanation |
| --- | --- | --- | --- |
| 1 | **Shell proportions** | **PASS** | Left rail ≈ 220–235 px at desktop, compact top bar spanning the content, search control upper-left with `/` kbd hint, prominent blue→violet **New workflow** primary upper-right, deep midnight canvas with thin blue-tinted borders. (`p62_inspect_abort_full.png`, `p62_overview.png`) |
| 2 | **Header geometry** | **PASS** | Breadcrumb → sigil + title + version + status badge → started/elapsed/definition meta row, with a snapshot timestamp at the right edge, matching the reference's exec-header band. The reference's inline Pause/Cancel/More buttons are intentionally relocated to the right **Operator actions** rail and **Pause is not offered** because the engine does not admit it — an honest data constraint, not a layout miss. |
| 3 | **KPI strip** | **PARTIAL** | Five compact cards in one row (Total / Completed / Active / Failed·aborted / Manual) with strong numeric hierarchy and subtle status accents — matches the reference geometry. **Sparklines and ▲/▼ trend deltas are deliberately omitted**: the backend exposes only durable counters and gauges, no per-metric time series, so a sparkline would be fabricated. This is the honest gap required by §2/§6. |
| 4 | **Graph size & position** | **PASS** | Wide execution graph occupies the dominant left column; narrower details rail aligned right; dotted canvas background; progress bar directly beneath. Nodes now fill the canvas instead of floating in dead space. |
| 5 | **Node & connector design** | **PASS** | Custom icon-circle nodes with concise labels; distinct completed/running/compensating/failed/manual/pending treatments; curved connectors with consistent spacing and arrowheads; controlled red/coral failure and teal success. Only the real sequential chain (position order + compensator attribute) is drawn — no invented branches. |
| 6 | **Details panel** | **PASS** | Right rail "Workflow details" with ID (mono + copy), Status, Definition, Business key, Current step, Version, Started, Duration, Deadline, Updated and a "View input & definition" action — mirrors the reference's attribute list. |
| 7 | **Tab bar** | **PASS** | One continuous horizontal strip: Execution Flow · Steps · Events · Attempts · Input / Output · Audit Trail · Traces. Active tab is unmistakable (underline + faint gradient tint, no excessive glow). Every tab resolves to real content or an explicit unavailable/empty state. |
| 8 | **Lower panels** | **PASS** | Dense three-panel row — selected **Step**, **Event log** (timestamp · severity · message), **Execution metrics** tiles — with deliberate heights, aligned headings, consistent borders and internal scroll, matching the reference's lower band. |
| 9 | **Typography** | **PASS** | Space Grotesk on headings/wordmark, Inter for UI/body, JetBrains Mono for IDs, timestamps, JSON and technical values. No new fonts introduced. |
| 10 | **Background & surfaces** | **PASS** | Deep midnight canvas, thin blue-tinted borders, carefully separated surface elevations (rail / panel / inset), low-contrast dotted graph field. |
| 11 | **Mountain artwork** | **PASS** | Original SVG rebuilt into a cinematic layered alpine range: midnight/navy shadows, four depth planes, atmospheric fog + valley pool, blue-violet rim light, snow caps, top/bottom fade into the chrome, low contrast behind nav. **Documented deviation:** an authored vector rather than a downloaded photograph (tooling must not fetch binaries; a third-party photo carries an unverifiable licence chain). Fully project-owned; see `docs/ASSET_ATTRIBUTION.md` §2a. |
| 12 | **Animation & interaction quality** | **PASS** | Animated dash flow only on genuinely active transitions; restrained selected-node glow; hover states; smooth transitions driven by real polled state. Nothing animates progress without a new backend event. Global `prefers-reduced-motion` neutralises all durations. |
| 13 | **Responsive behaviour** | **PARTIAL** | Breakpoints at 1240 / 780 / 520 px collapse the two-column grid, wrap the KPI strip and stack the lower panels; genuine 390 × 844 captures from earlier phases confirm the stacked layout. Marked PARTIAL only because this session's tooling could not re-capture a true mobile viewport to re-verify the *6.2-specific* tweaks at 390 px. |

**Tally:** 10 PASS · 3 PARTIAL · 0 FAIL. Every PARTIAL is a deliberate honesty
constraint (no fabricated data) or a capture-tooling limitation, not a visual
regression.

---

## 4. Where the reference is intentionally *not* reproduced

These are faithful-to-the-backend choices, called out so they are not mistaken
for misses:

- **Branching DAG.** The reference shows a 5-node order flow with a branch and a
  compensation fork. The real demo workflows are 1–2 step sequential chains, so
  the graph renders exactly that. No vertices were invented to match the picture.
- **Sparklines / success-rate / CPU / memory / worker-count / resource-usage
  area chart.** The engine exposes none of these; the panels say so plainly
  ("Host CPU, memory and connection telemetry are **not exposed** by the engine")
  rather than simulating them.
- **Running-node colour.** The reference tints the active node cyan; the design
  system reserves cyan/teal for terminal success and uses **amber** for the live
  running/compensating state, keeping the internal status palette consistent
  across all screens.
- **Pause control.** Not offered — the state machine does not admit it.

---

## 5. Acceptance gate (§9)

| Gate | Result |
| --- | --- |
| Full execution-inspector composition visibly present | ✅ (`p62_inspect_abort_full.png`, `p62_inspect_success_full.png`) |
| Main geometry & information hierarchy match reference | ✅ shell / KPI / graph+details / tabs / lower / footer all present |
| Graph is the visual centrepiece | ✅ widest, brightest, first element below the header |
| Mountain artwork has intended cinematic quality | ✅ four-plane layered SVG with fog/rim-light/fade |
| Custom font, logo, favicon consistently integrated | ✅ Space Grotesk/Inter/JetBrains Mono; orchestration-diamond mark at 16/32/48 px |
| Visual changes preserve real API behaviour | ✅ every value is a real StepView/Workflow/audit/Prometheus fact; auth, probes, actions intact |
| No new page-wide overflow / broken assets / console errors / keyboard regressions | ✅ no red console errors; step-rail arrow-key navigation intact; assets same-origin |
| All major screenshots captured & comparison complete | ✅ this document |
| Typecheck / tests / lint / production build pass | ✅ build exit 0; `eslint .` 0 errors / 9 pre-existing warnings; 30/30 tests |
| Honest explanation for anything unachievable | ✅ §1, §3 (PARTIAL rows), §4 |

### Known non-blocking console noise
- React Flow "attribution hidden" notice — a supported `proOptions` feature on an
  MIT dependency (licence-clean; documented in `ASSET_ATTRIBUTION.md` §4).
- A transient "parent container needs width or height" warning during the graph's
  first mount frame; the canvas settles to a real size (≈ 897 × 214) and renders
  correctly. Not a functional or visual defect.

---

## 6. Screenshots inventory (local review artifacts, not committed)

| File | Screen | Size |
| --- | --- | --- |
| `baseline_1536x816_abort_full.png` | Inspector (before, aborted) | 1536 × 816 |
| `p62_inspect_abort_full.png` | Inspector (after, aborted/compensated) | 1906 × 1525 |
| `p62_inspect_success_full.png` | Inspector (after, completed) | 1906 × 1478 |
| `p62_overview.png` | Overview | 1920 × 1020 |
| `p62_dlq.png` | Dead Letter | 1920 × 1020 |
| `p62_metrics.png` | Metrics | 1920 × 1020 |
| `p62_settings.png` | Settings | 1920 × 1020 |
| `F_inspector_mobile_390x844.png` / `reval_M2/M3_390x844_*` | Inspector mobile (earlier genuine capture) | 390 × 844 |
