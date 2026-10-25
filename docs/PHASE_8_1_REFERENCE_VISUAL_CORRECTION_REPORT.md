# Phase 8.1 — Reference-Match Visual Correction Report

**Date:** 2026-10-25 · **Branch:** `main` · **Operator session:** Qoder
**Reference:** `.artifacts/p8/reference.png` (1200 × 900, git-ignored — not committed)
**Prior state:** Phase 8 (`3ace578`…`e820b84`), which this phase replaces on every screen.

Phase 8 was rejected: *"still a conventional technical monitoring dashboard with generic cards,
flat icons, a sparse bar chart, a repetitive diagonal background, and a uniform sidebar… I do not
want another color adjustment or minor CSS pass."* This phase is not a colour pass. The bar chart
was replaced with a different chart type built on a different data model, the dot matrix the
reference has was implemented from scratch, the background was rebuilt as directional light rather
than a repeating pattern, every KPI card was given its own visualization, and the brand mark and
favicon were drawn. Below, each of the 13 numbered requirements is answered with what changed and
the measurement that proves it.

**Frozen, as before:** the Go control plane, its API contracts, authorization, engine semantics and
persistence. No data was manufactured to fill a panel.

---

## §1 Overview recomposition

The reference's hierarchy — rail → header + compact controls → rich summary cards → prominent
central graph → lower-left activity matrix → supporting lists and a colourful donut → compact
secondary info — is now the DOM order of `web/src/screens/Overview.tsx`, in that sequence:

| Band | Panel | Occupancy |
| --- | --- | --- |
| 1 | Header: kicker, title, one-line promise, snapshot stamp, degraded pill | — |
| 2 | KPI strip — 5 cards, each with its own visualization | full width |
| 3 | **Placement flow** (the primary chart) `lg:col-span-2` + Control plane gauges | dominant |
| 4 | **Execution ledger** (activity-dot matrix) `lg:col-span-2` + State census donut | lower-left |
| 5 | Recent executions `lg:col-span-2` + Dead letters | supporting lists |
| 6 | Volume by definition + Wall time to terminal | compact secondary |
| 7 | Honesty footer (source of every number, timezone) | — |

The central graph is no longer a huge empty panel: seven real placements draw seven full-width
tracks across a fitted 44 h axis (§3), and the matrix below it fills its own panel edge to edge
with 7 × 24 cells (§4). The old single-bar histogram is gone.

---

## §2 KPI cards with real personality

Five cards, five different figures — all computed from the same real numbers, none decorative:

| Card | Visualization | What it encodes |
| --- | --- | --- |
| Placements | `SpectrumBar` | every state's share of the durable census, plus a 3-row legend |
| Success rate | `ProgressRing` | completed ÷ terminal, drawn as an arc; `—` when nothing is terminal |
| Active | `NodeMotif` | the five live step states as a rail; an explicit *idle* figure when all are zero |
| Failed / aborted | `MiniSplit` | Failed, Aborted and Manual as three ranked bars |
| Queue depth | `QueueBars` | dead-letter depth per class and outbox backlog as vessels |

Rules the brief set and the code keeps:

- **No generic icon tile repeated across the strip.** `KpiCard` renders the `visual` when present;
  the icon is a 14 px glyph beside the kicker, not a tile. The same rule was then applied to the
  two other KPI strips in the app (§10) — before that, the inspector and metrics strips were each
  five identical icon tiles, which the first sweep caught.
- **Layered lighting, coordinated hues.** Each card takes its own hue from its status tone
  (`--st-*`) or the lime primary, and paints it into a corner gradient, the icon and the figure.
- **Trend only where data supports it.** There is no sparkline anywhere: `/metrics` exposes
  cumulative counters and gauges only, so a delta cannot be computed. `delta` is used for honest
  computed ratios such as "3 of 7 terminal".
- **No false measurement.** Two examples found and fixed: `QueueBars` used to floor every bar at
  6 % of the vessel, so a queue of zero drew a nub — it now draws a genuinely empty vessel inside a
  declared ring. `NodeMotif` used to draw a faint rail of hollow nodes that read as "five idle
  workers"; it now draws a distinct *idle* figure with `role="img"` and the label "No steps are
  currently held by a worker".

---

## §3 The sparse bar chart — root cause, not restyling

The brief asked for an investigation across six specific surfaces. All six were checked against
the live backend, and the finding is recorded as a runnable reproduction,
`.artifacts/p81/bucket-defect.cjs`, which replays the old arithmetic over the verbatim
`GET /v1/workflows` response captured in `.artifacts/p81/wf.json`:

```
placements in ledger      : 7
age of each placement (h) : 41.6 40.5 40.5 40.4 38.1 38.1 16.9
actual span               : 1.03 days

old fixed-bucket histogram (7 buckets x 1 d over the 7 d window):
  0 0 0 0 0 6 1
  empty buckets           : 5 / 7
  tallest bar             : 6 of 7 placements = 86% of the series
```

| Checked | Finding |
| --- | --- |
| API response | Complete and correct — 7 rows, every `created_at`/`finished_at` present and parseable |
| Timestamps | Real and bimodal: six placements in a 3 h burst ~40 h ago, one ~17 h ago |
| Selected time range | 7 d, the widest option; the window itself was not the fault |
| Bucket generation | **The defect.** Seven fixed 1-day buckets over a 7-day window |
| Aggregation | Correct counts, wrong shape — counts collapse a 1-day spread into a 7-day frame |
| Chart domain | `[0, max=6]`, so one bar fills the panel's height and five of seven slots are empty |

So it was an implementation defect, not a data defect: **a fixed-bucket histogram over a window
much wider than the activity inside it.** The fix is architectural rather than cosmetic — the
panel no longer counts placements into buckets at all.

`timePlane()` (`web/src/lib/aggregate.ts`) now fits the axis to the first and last real timestamp
returned by the walk, `timelineTracks()` draws **one track per placement** from `created_at` to
`finished_at` (open rows extend to the snapshot instant), and the panel states the fit out loud:
*"Axis spans 45h 48m · 7 placements · **fitted**"*, with a Popover that discloses the walk
parameters (page size, page cap, rows walked, placed in range) and the truncation warning when the
cap stops the walk before the window opens. The span is measured against the snapshot instant, so
it grows with wall-clock time — a re-run tomorrow reads a little wider, which is the honest
behaviour of a fitted axis, not a regression. Nothing is extrapolated into the empty days; the
history that does not exist is simply not drawn.

Layout integrity is measured, not assumed. `axis.mjs` reports label collisions per viewport and
`layoutTicks()` drops a label rather than overprinting it — at a 190 px track it keeps two labels,
at 370 px three, at 1536 five, `overlap: 0` in every case.

---

## §4 The activity-dot matrix

`ActivityMatrix` in `web/src/components/flow.tsx`, fed by `activityMatrix()` in `aggregate.ts`, is
new. It is the reference's lower-left grid, drawn from the same walked rows the timeline uses, so it
costs **zero extra requests** against the 100 req/min limiter.

- **Geometry:** one row per placement × 24 slots across the fitted span; slot width is
  `100/24 %` so the grid fills its panel at every viewport.
- **Cell kinds** come only from real ledger fields — `placed in slot` (`created_at`), `in flight`
  (created→updated with no terminal), `ledger row moved` (`updated_at` between boundaries),
  `terminal success`, `failed or aborted`, `needs a human`, `settled` (an interior cell with no
  change since the last mark), and `did not exist yet` (before the row's `created_at`).
- **Missing data vs inactivity are different glyphs:** an absent cell is a low-alpha filled dot,
  a settled cell is a hollow ring. The legend names both.
- **Interior in-flight cells are dimmed** (`opacity-35`) when both neighbours are also in flight, so
  a long run reads as a band rather than as 20 identical events.
- **Time labels** sit above the grid and thin out by measured collision, same as the timeline.
- **Every dot is a button** with an `aria-label` naming the placement, the slot and the outcome;
  hover and focus raise a tooltip that navigates to that workflow's inspector. Verified live:
  `/workflows/01a16e70-1e3e-7e5a-885a-67b6d7db8f1f`.
- **Entry animation** `@keyframes matrixIn` scales dots in, and is covered by the global
  reduced-motion kill switch.

---

## §5 Background atmosphere

The previous backdrop used `repeating-linear-gradient(118deg, … 0 2px, transparent 2px 26px)` — a
literal tile, which is exactly why it read as "a tiled CSS pattern". It is deleted.
`@utility surface-atmosphere` (`web/src/index.css`) now stacks six layers of *different* geometry:

1. an outer vignette darkening the frame edges,
2. three wide luminous bands at deliberately different angles (112°, 124°, 106°) with different
   widths and 6–11 % alpha, so no two repeat at the same pitch,
3. a 135 % upper-left green sun at 92 % alpha,
4. the base 150° forest-green field.

`surface-frame` adds two more interior streaks (118°, 126°) at 7 % and 4.5 % so the light reads as
falling *into* the canvas. The result is directional, non-repeating light: visible in
`overview@1536.png` as a brighter top-left corner, a diagonal wash across the header, and a
darker bottom-right — not a grid.

---

## §6 Sidebar hierarchy

`RailContent` in `web/src/shell/Shell.tsx` was rewritten around one idea: the rail is a column of
small circles under a distinctive mark, not a column of large equal icons.

| Element | Before | After |
| --- | --- | --- |
| Rail width | 74 px | 68 px |
| Brand | 44 px rounded-square tile, 26 px mark | 44 px **circular medallion**, lime ring + 26 px glow, 24 px mark |
| Nav glyph | 44 px button, 20 px icon at 1.9–2.3 stroke | 40 px hit area containing a **32 px circle with a 17 px icon** at 1.8–2.2 stroke |
| Active state | filled lime rounded rectangle | filled lime **circle** with a tighter 95 %-alpha shadow |
| Inactive | `text-muted-foreground` | `text-muted-foreground/85`, group-hover chip |
| Bottom utility | same size as nav | compact status cluster, visually subordinate |

The drawer (`labelled`) variant keeps the same glyph circles with a text label, so the two
presentations share one visual language instead of diverging.

---

## §7 Cards, typography and identifier hygiene

- **All-caps removed app-wide.** `grep -rn uppercase web/src` now returns **zero matches** — the
  sweep of 43 remaining `tracking-*`/`tabular-nums` uses are spacing and numeral alignment, not
  case. Micro-labels went from `text-[10px] uppercase tracking-[0.14em]` to `text-[11px]
  text-muted-foreground`, which also fixes the contrast complaint: the old 10 px caps measured
  below the secondary-text target, the new 11 px sentence case sits on `--muted-foreground`.
  The base `TableHead` lost its `uppercase tracking-wide`, and the per-screen overrides in
  Workflows, DLQ, Events, WorkflowDetail and NotFound went with it.
- **Implementation identifiers moved to tooltips and detail rows.** Panels take a `source` prop —
  `fathom_workflows_total`, `GET /v1/workflows · created_at → finished_at`,
  `fathom_relay_publish_lag_seconds` — rendered as a 20 px ⓘ chip. The chip is a real Radix
  `Tooltip` (self-providing `TooltipProvider`, keyboard focusable via `tabIndex={0}`) that shows
  the full identifier in mono. Titles and kickers read as English ("Every workflow this store
  created"), the metric name is one hover away.
- **Card quality.** One radius language (`rounded-[20px]`), one hairline, one shadow, kicker →
  figure → sub-line rhythm, and `@container` on `KpiCard` so a card reflows when *its own box* is
  narrow rather than when the viewport is.

---

## §8 Supporting visualizations, without redundancy

Each new figure answers a different question and no two read the same axis twice:

| Figure | Question it answers | Where |
| --- | --- | --- |
| Placement flow | when was each placement made, and how long did it take | Overview band 3 |
| Execution ledger matrix | what did the ledger record per placement over time | Overview band 4 |
| State census donut | what exists right now, by state | Overview band 4 |
| Control-plane gauge rings | how far past budget are the oldest open/dead items | Overview band 3 |
| Volume by definition | which definitions produce work and how each ended | Overview band 6 |
| Wall time to terminal | distribution of individual execution durations, with p50/p95 | Overview band 6 |
| Transition ledger | which state edges the machine actually crossed | Metrics |
| Graph + progress + step rail | where this one workflow is stuck | Inspector |

The matrix and the flow share a source but not a reading: the flow answers *when and how long*,
the matrix answers *what changed in each slot*. Both say so in their kicker.

---

## §9 Brand mark and icons

One geometry — a two-peak ridge with a lit snow cap over a gradient body — is defined once in
`web/src/components/brand.tsx` and rasterised once by `.artifacts/p81/mkicons.mjs`:

| Artifact | Size | Used by |
| --- | --- | --- |
| `web/public/nunatak.svg` | vector | `<link rel="icon" type="image/svg+xml">`, modern browsers |
| `web/public/favicon-16x16.png` | 16 px | tab fallback |
| `web/public/favicon-32x32.png` | 32 px | `<link rel="icon" sizes="32x32">` |
| `web/public/apple-touch-icon.png` | 180 px | `apple-touch-icon` |
| `NunatakMark` in the rail | 24 px inside a 44 px medallion | every screen |

The SVG uses CSS variables in-app and literal hex standalone, where no stylesheet is attached. The
stale Vite-era icon is gone; `web/index.html` declares `theme-color: #090e08` so the browser chrome
matches the atmosphere. Verified against the running dev server: each href resolves 200 with the
expected `content-type`, and the DOM carries exactly the four icon links.

---

## §10 Applied across the application, not just Overview

| Route | What the correction changed |
| --- | --- |
| `/` Overview | recomposed (§1), new chart (§3), new matrix (§4), five distinct cards (§2) |
| `/workflows` | de-uppercased heads, sentence-case filter chips with live counts, ledger footer stating the sort/paging scope |
| `/workflows/:id` | **fleet-census strip rebuilt** — five identical icon tiles replaced by four cards with distinct real visuals (spectrum, ring, node rail, split); graph, step rail and panels on the same system |
| `/dlq` | stat cards on the shared surface language, action cards with dry-run preview, no caps |
| `/events` | scope picker as chips, per-instance disclosure, no caps |
| `/metrics` | **KPI strip rebuilt** with five distinct visuals; human-readable panel kickers with the metric name behind a ⓘ tooltip; Ageing & backlog readouts laid out 2-up so the panel no longer ends in dead space |
| `/settings` | source tooltip on the definitions panel, no caps |
| `*` NotFound | on-system card, medallion-consistent, six real navigation exits |
| shared | loading, empty, error and degraded states all use the same Panel/Alert language; the degraded `/readyz` renders as the coral band, never as healthy |

The inspector and metrics strips are the important part of this pass: Phase 8.1's first sweep
showed the correction had stopped at Overview, which is precisely the failure mode the brief
called out.

---

## §11 Installed technologies, used in real code

No dependency was added and none left unused:

| Package | Used here for |
| --- | --- |
| `radix-ui` 1.8.1 | the new `Tooltip` on every panel source chip; popover, dialog, tabs, dropdown, sheet unchanged |
| `tailwindcss` 4.3 | `@utility surface-atmosphere/frame`, `@container` + `@[13rem]:`/`@[22rem]:` variants, arbitrary child variants for the KPI grids |
| `@xyflow/react` 12.12 | inspector graph (attribution kept visible; no Pro licence) |
| `recharts` 3.10 | donut, mix bars, duration bars, gauge rings, transition bars — all still consumed |
| `@tanstack/react-query` 5.104 | every live read; the matrix reuses the placement walk, so it adds no requests |
| `motion` 14.6 | KPI stagger, matrix `matrixIn`, bar vessel growth, under `reducedMotion="user"` |
| `lucide-react` 1.61 | the 14 px kicker glyphs and the 17 px rail glyphs |
| `cmdk`, `sonner`, `cva` | palette, toasts, variant composition |

The old `TrendChart` was deleted outright rather than left exported-but-unused; `recharts`
remains because six other primitives still render through it.

---

## §12 Verification

### Gates (final tree)

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `npx eslint .` | 0 errors, 15 warnings (all pre-existing `react-refresh/only-export-components` from vendored shadcn) |
| Types | `npx tsc -b` | 0 errors |
| Tests | `npx vitest run` | 65 passed / 10 files |
| Build | `npm run build` | success |
| CSS emit | `node ../.artifacts/p81/css-audit.cjs` | 89 arbitrary utilities extracted from source, **0 missing**; `@keyframes matrixIn` present |
| Format | `npx prettier --write` on touched files | clean |
| Icons | `node qa/icons.mjs` | 4 declared icon links resolve (`200`, correct content type, PNG IHDR confirms 16×16 / 32×32 / 180×180, SVG is vector); stale `/vite.svg` and `/favicon.ico` are **not served** — `ICONS OK` |

The CSS audit was upgraded this pass: instead of a hand-typed list, it extracts **every**
arbitrary-value or arbitrary-variant class from `web/src` and greps the emitted stylesheet for the
escaped selector. That closes the trap that bit Phase 8, where `break-anywhere` typechecked,
linted, built and passed tests while compiling to nothing.

### Visual sweep

`.artifacts/p81/qa/sweep.mjs` drives one headless Chrome over CDP: 9 route slots × 5 viewports
(390 / 768 / 1024 / 1280 / 1536) = **45 full-page captures**, each measured twice with slack so
the last panel is not clipped, with `Network` and `Log` domains recording every console error and
failed request per route.

`sweep.log` records **45 / 45 captures produced, 45 flagged, and all 45 flags are the same single
cause**: `http 503: /readyz` (`relay_lag`, see §13). `grep '!!' sweep.log | grep -vc readyz` →
**0**, i.e. not one other console error, failed request, or clipped panel across nine route slots
and five viewports. The coral readiness band is the product being truthful, not a defect.

### Interaction harness

`.artifacts/p81/qa/interact.mjs` asserts behaviour against the live DOM with trusted CDP input
events (synthetic `el.click()` does not open Radix poppers). **16 checks, 16 passed:**

range selector present · range selector changes axis (`45h 48m · 7 placements` → `1h 4m · 1
placement`) · 1 h range re-fits or explains emptiness · axis caption opens the methodology popover ·
data-source tooltip on hover · data-source tooltip on **keyboard focus** · matrix dots expose aria
labels · matrix tooltip offers inspector navigation · matrix tooltip navigates to inspector ·
inspector graph node is interactive · inspector tabs switch · ⌘K palette opens · new-workflow
dialog opens · ledger header sort is wired · ledger state filter is wired · settings time-format
control responds.

### Second correction pass

The first sweep was measured, not admired, and caught five defects that the code review had missed:

| # | Defect | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | KPI kickers rendered **one letter per line** at 390 px — a fixed 44 % visual column plus `[overflow-wrap:anywhere]` starved the text | `overview@390.png` | `KpiCard` is now `@container`: the side-by-side rule keys off the card's own 13 rem width, and the kicker wraps normally |
| 2 | Axis labels overprinted each other on narrow tracks | `axis.mjs` measured 190 px and 370 px tracks | `layoutTicks()` measures every label box against its neighbours and drops collisions, pinning first/last to the edges |
| 3 | `QueueBars` drew a 6 % nub for a zero queue — a false measurement | 1280 frame, DEADLINE vessel | true zero inside a declared ring |
| 4 | The inspector and metrics KPI strips were still five identical icon tiles — the correction had stopped at Overview | `inspector@1536.png`, `metrics@1536.png` | both strips rebuilt on the shared visual kit (§10) |
| 5 | The 5-card KPI strips left an empty cell at 1024 px | `overview@1024.png` | the fifth card spans the two remaining `lg` columns and resets at `xl`; the inspector strip is 4-up |

One honesty defect was also caught in review: the inspector's "Failed / aborted" card counted
`FAILED + ABORTED + FAILED_MANUAL`, so the headline disagreed with its own label. It now counts
failed + aborted, with manual shown as its own bar and link.

---

## §13 Deliverables, limitations and tree status

**Deliverables:** this report, the corrected `web/` tree, and the evidence under
`.artifacts/p81/` (`reference.png`, `wf.json`, `metrics.txt`, `bucket-defect.cjs`,
`css-audit.cjs`, `mkicons.mjs`, `qa/sweep.mjs`, `qa/axis.mjs`, `qa/interact.mjs`,
`qa/icons.mjs`, 45 final screenshots, and `sweep.log` / `axis-run.log` / `interact-run.log`
as the runs were actually printed).

**Genuine limitations**

- **Readiness really is degraded here.** `/readyz` answers `{"status":"unavailable",
  "reason":"relay_lag"}` because mode `all` skips the Kafka relay, leaving 12 outbox rows ~41 h
  old. The coral band and the 503 in every capture are the product telling the truth.
- **The fleet is 7 workflows.** The fitted axis is honest about a thin ledger, but a reviewer
  wanting to see a dense multi-day flow needs a seeded store; nothing was invented to fake it.
- **No global event stream, no rate-based series.** So no "recent events" panel and no sparklines,
  both of which the reference has. Their absence is a backend fact, stated in the panels.
- **Step timing is not exposed on the list endpoint**, so the matrix can only claim "the ledger row
  changed in this slot" — which is exactly what its footnote says.
- **Wide tables scroll horizontally on phones**; the page never overflows, but columns past the
  fold need a swipe and there is no sticky first column.
- **Dark only** — no light counterpart to the token pair yet.
- Screenshots are full-page captures at `deviceScaleFactor 1.5`, so very tall pages are
  downsampled; fine detail was verified by the DOM probes rather than by zooming into a PNG.

**Commits and tree status**

| Hash | Scope |
| --- | --- |
| `6e59bc4` | M1 — directional-light atmosphere replacing the tiled diagonal, brand mark and icon rasters, `aggregate.ts` time-plane rebuild, the new `flow.tsx` visual kit, `charts.tsx` sparse trend removed |
| `69415db` | M2 — `KpiCard` gains `visual` / `accent` / `delta` slots and layered lighting, secondary-label contrast, rail hierarchy and the 74→68 px narrowing |
| `a32ba87` | M3–M6 — Overview recomposition, the execution ledger graph and activity matrix, and every remaining route on the same system |

`git diff --stat e820b84..a32ba87` — **21 files changed, 1875 insertions, 562 deletions**, all
under `web/`. The Go control plane, its API contracts, authorization, engine and persistence are
untouched; this phase is presentation and the client-side aggregation that feeds it.

Honest caveat on the grouping, carried forward from Phase 8: the commits are layered so a reviewer
can read them in order, and **only the final tree was gated**. An intermediate commit is not
guaranteed to build on its own, because screens and the kit they import landed in separate commits.

This report lands as its own commit. The commit you are reading this line in is the follow-up that
pins it — a commit cannot contain its own hash.

Working tree after Phase 8.1: clean. `.artifacts/` (screenshots, harnesses, reference image) stays
git-ignored as designed, and nothing was pushed or deployed.
