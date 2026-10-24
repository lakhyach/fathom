# PHASE 6.7 — Nunatak Visual Acceptance Audit and Final Premium Redesign

Baseline: Phase 6.6, commit `f963ea9`. This phase audited the *rendered* application
against the premium cockpit reference, fixed the concrete deficiencies found, and
re-verified in a real browser. Nothing below is claimed without a screenshot,
DOM measurement, or command output behind it.

---

## 1. Audit method

1. Fresh 40-shot matrix of the *pre-fix* state (8 routes × 5 viewports:
   1536×1024, 1280×800, 1024×768, 768×1024, 390×844) → `.artifacts/p67/audit-*.png`.
2. Every route inspected individually at desktop + mobile; a per-route deficiency
   list was written from what the screenshots actually show, not from the code.
3. Fixes implemented (section 3), then a full re-capture (`.artifacts/p67/fixed-*.png`,
   `.artifacts/p67/final-*.png`) and live interaction tests through the connected
   browser (section 5).

## 2. Route-by-route visual audit (pre-fix findings)

| Route | Verdict | Concrete deficiencies found in screenshots |
|---|---|---|
| Overview | close, two flaws | Bottom row uneven: Ingress (2 bars) and Dead-letter (1 bar) rendered as slivers beside a towering System-pulse panel, leaving dead space bottom-left. Gauge label `17h 13m` touched the ring stroke. Mobile: KPI kickers truncated (`TOTAL WORKFL…`). |
| Workflows | weakest route | Table ended abruptly mid-viewport (~45% dead space below 6 honest rows); ID cell was noisy — truncated uuid plus a bordered `id` chip that read as part of the identifier; subtitle wrapped with an orphan word. |
| Execution inspector | signature, one flaw | 1–2-step graphs fit to maxZoom 1.35 → nodes floated as postage stamps in a large dark stage (the opposite of the "large interactive graph" reference). `rolling back` label wrapped over the node border. |
| Dead Letter | pass | Stat tiles, cards, rails all compose correctly at every viewport; no route-specific deficiency found. |
| Events & Audit | flat default state | The primary affordance (pick a workflow) was a row of micro-chips showing only a business key; the rest of the page was one large empty box. No state, definition, or age visible. |
| Metrics & Health | same bottom-row flaw | `fx-grid-3` row (Ingress / Dead-letter / Relay lag) had the identical sliver-vs-tower imbalance; gauges cramped. |
| Settings | pass | Session ribbon, probes, definitions all read well. Probe rows are plain but honest; left as-is deliberately (decoration would not add meaning). |
| NotFound | pass | Gradient ridge glyph + CTA compose correctly; verified in 6.6 matrix, unchanged since. |

Cross-cutting: the identity (midnight navy, Nunatak ridge art, blue→violet accents,
tone system) survives the audit — the flaws were composition and density problems,
not skin problems. No route failed outright; four routes had real, fixable gaps.

## 3. Changes implemented (all verified in re-captured screenshots)

| Fix | Files | What changed |
|---|---|---|
| Even bottom rows | `screens/screens.css` | `.fx-grid-3` now stretches; member panels flex their bodies and vertically centre sparse charts, so 1-bar panels read as composed members of a row (Overview + Metrics). |
| Honest ledger footer | `screens/Workflows.tsx`, `screens.css` | New strip under the pager: definition mix of the loaded page (`echo-single ×3 · echo-compensate ×2 · loop-test ×1`) + "page shows 6 workflows · newest first". States only what the keyset page actually contains — the API has no total count, so none is claimed. |
| Quiet ID cells | `components/ui.tsx`, `ui.css`, `Workflows.tsx` | `CopyChip` gains a `bare` icon-only ghost variant; the explorer now shows uuid + a subtle copy icon instead of a second bordered chip. |
| Graph scale | `screens/WorkflowDetail.tsx`, `graph/layout.ts` | fitView `maxZoom` 1.35 → 1.75 (padding 0.16): 1–2-step workflows now fill the stage with intent (measured: node renders 367px wide on screen, name fully legible). `NODE_W` 188 → 216 to make room for the rollback pill without truncating step names (verified by DOM measurement: `truncated: false`). |
| Rollback pill | `graph/StepNode.tsx`, `graph.css` | `rolling back` moved from the crowded foot row into the node top row as a nowrap tone-tinted pill; containment verified geometrically in-browser (pill rect fully inside node rect). |
| Quick-pick cards | `screens/Events.tsx`, `screens.css` | Recent workflows upgraded from micro-chips to a card grid: definition name, state dot + label, business key, live relative age; selected card gets the blue edge. Clicking one scopes the feed (verified live). |
| Gauge legibility | `components/charts.css` | Ring rendered at 88px with 11.5px inner text — `17h 13m` now keeps clear air from the stroke (verified at 1536 and 390). |
| Mobile KPI kickers | `screens.css` | ≤520px kickers wrap to two lines instead of ellipsis-truncating. |
| Copy polish | `Workflows.tsx` | Subtitle shortened to remove the orphaned-word wrap. |

No new dependencies. No fabricated data (the ledger footer, quick-pick cards, and
census all derive from already-served API rows).

## 4. Design-toolkit audit (re-verified against the live environment)

MCP inventory re-read from the live tool cache this session — **exactly two servers,
unchanged**: `browser-use` (17 tools) and `genui` (2 tools).

Real-operation verification (what was *used*, not just listed):

- **browser-use** — used extensively this phase: opened routes, injected the local
  dev key, clicked quick-pick cards and tabs, measured node/pill geometry via
  `evaluate_script`, captured evidence screenshots, enumerated console messages.
  Status: **connected and used**.
- **genui** — `load_guidelines({modules:["chart"]})` executed this session and
  returned its real design-system payload (CSS variable contract, Chart.js palette,
  CDN allow-list). Status: **connected and verified with a real operation**. Not
  further used because its `show_widget` renders chat-panel widgets, which are not
  part of the cockpit product being redesigned.

Matrix for every named candidate (statuses identical to 6.6 unless re-check found
movement — none did):

| Candidate | Status / blocker |
|---|---|
| shadcn/ui + registries | Not installed — would duplicate the bespoke `fx-*` design system with a second component layer (spec forbids duplicate systems). |
| 21st.dev / Magic | Not present as MCP; registry access requires manual marketplace config; components target Tailwind — incompatible without a second styling system. |
| Figma MCP | Not connected; requires a Figma account token + desktop file — credentials not available, not authorized to create. |
| Context7 | Not connected; requires marketplace add in the IDE. Redundant: all library APIs used here were verified against installed package sources. |
| Penpot MCP | Not connected; no Penpot instance exists locally; would need self-hosted server + account. |
| Flowbite | Not installed — Tailwind-component library, duplicates design system (same verdict as 6.6). |
| Storybook | Not installed. Feasible (npm-only) but rejected: adds a large dev dependency without improving any rendered route; visual QA is covered by the CDP matrix + browser-use. Documented decision, not an oversight. |
| Playwright / Chrome DevTools | Functionally present: deterministic CDP harness (`.artifacts/capture.mjs`, Chrome 155 on :9222) + browser-use MCP drive a real Chromium. A parallel Playwright install would duplicate this exactly — not added. |
| Filesystem / Git / Fetch | Native agent tools already cover these; an MCP would be a redundant wrapper. |
| Runway, Luma, fal.ai, Replicate, FLUX, Recraft, Kling, Pika, Krea | All require paid third-party accounts/API keys — not present, not authorized to purchase. No creative-asset generation was needed: every fix this phase was composition, not artwork. |
| Blender, Meshy, Tripo | Not connected; 3D asset generation has no role in this product surface. |
| Canva, Webflow, Framer | Require external accounts + manual marketplace MCP configuration; none available in this environment. |

## 5. Validation results

**Capture matrix** (final run, label `final`): 40 shots, **horizontal overflow: none**
across all 8 routes × 5 viewports. Files: `.artifacts/p67/final-<route>@<w>.png`
(routes: overview, workflows, insp-completed, insp-aborted, dlq, events, metrics,
settings) plus pre-fix `audit-*` and mid-fix `fixed-*` sets for comparison, and
browser evidence: `evidence-inspector-rollback@1280.png` (overflow bug),
`evidence-inspector-fixed@1280.png` (final).

**Live interaction tests (browser-use, real clicks):**
- Events quick-pick card click → URL scoped, audit feed loaded 6 items; inbound tab
  switch → 3 items with tone-marked feed. ✓
- Inspector node click → selection glow + spotlight edges (incident edge opacity 1). ✓
- Workflows: 6 bare copy buttons present (sr-only label), ledger footer text exact. ✓
- Rollback pill containment measured: pill rect fully inside node rect. ✓
- Console during the session: **0 errors**; only the pre-existing React Flow
  attribution warning. ✓

**Gates (final state):**
| Gate | Result |
|---|---|
| `npm run build` (tsc -b + vite) | PASS · 729 modules · 243.9 kB gzip (+0.2 kB, no new deps) |
| `npm run lint` | 0 errors · 10 warnings (all pre-existing react-refresh/only-export-components) |
| `npm test` | 34/34 PASS (7 files) |
| Console (40-shot matrix) | 20 errors, all pre-existing classes: React Flow container-size during mobile emulation ×12, attribution ×8 |
| Network (matrix) | 299 failures, all triaged pre-existing: 205 ERR_ABORTED (harness rapid navigation cancels in-flight react-query fetches), 53× 429 (backend rate limiter — three back-to-back capture passes plus the browser session; by design), 41× 503 readyz (honest degraded state: no Kafka relay locally) |

## 6. Remaining differences from the reference — stated honestly

1. **Sparse-data pages**: Workflows/Events still show real whitespace with a 6-workflow
   dataset; the ledger footer and quick-pick cards frame it, but a populated staging
   dataset would look denser. Not fixable by design work without inventing data.
2. **Metrics census/transitions row**: the grid-2 pair keeps a mild height delta
   (donut panel vs 9 transition rows); equalizing it would need per-panel overrides
   that fight the content — left honest.
3. **readyz is degraded** (503, relay lag) — real local state, rendered honestly by
   the banner and chips; a green header requires standing up Kafka, not CSS.
4. **Single 244 kB gzip bundle**: React Flow dominates the inspector chunk; code
   splitting remains the known pre-existing recommendation, unchanged this phase.
5. **genui is connected but not product-relevant** — its output surface is the chat
   panel, not the cockpit; verified operationally and left at that.

## 7. Commit

One local commit on top of `f963ea9`. No remotes are configured; nothing pushed or
deployed. Files: `web/src/screens/{screens.css,Workflows.tsx,Events.tsx,WorkflowDetail.tsx}`,
`web/src/components/{ui.tsx,ui.css,charts.css}`, `web/src/graph/{graph.css,StepNode.tsx,layout.ts}`,
this report.
