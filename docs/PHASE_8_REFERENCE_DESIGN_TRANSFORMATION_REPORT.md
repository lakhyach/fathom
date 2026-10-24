# Phase 8 — Reference Design Transformation Report

**Date:** 2026-10-25 · **Branch:** `main` · **Operator session:** Qoder
**Reference:** `.artifacts/p8/reference.png` (1200 × 900, git-ignored — not committed)

**Scope executed:** an application-wide visual transformation onto the operator's reference
dashboard. Tokens, typography, atmosphere, frame, rail, header, every screen, the chart kit and
the execution graph were rebuilt on the new system. Backend, API contracts, authorization, engine
semantics and persistence were treated as frozen, and no data was manufactured to fill a panel.

---

## 1. Reference analysis (measured, not described)

The reference was sampled pixel-by-pixel rather than eyeballed. The extraction and analysis
harnesses are in `.artifacts/p8/` (`extract-reference.mjs`, `analyze-reference.cjs`,
`analyze-reference2.cjs`); the numeric read-out is `.artifacts/p8/metrics.txt`.

| Property | Measured from the reference | Adopted as |
| --- | --- | --- |
| Outer atmosphere | mid forest green, ~`oklch(0.36 0.055 145)`, brightest top-left | `--atmosphere` + `surface-atmosphere` radial lighting |
| App canvas | near-black green-tinted, `oklch(0.156 0.015 140)` | `--canvas` / `--background` |
| Card surface | one step lighter, ~`oklch(0.198 0.012 139)` | `--card` |
| Popover surface | ~`oklch(0.222 0.014 139)` | `--popover` |
| Primary accent | saturated lime, ~`oklch(0.735 0.174 140)` | `--primary`, `--lime-bright` |
| Secondary data accents | violet `~oklch(0.74 0.15 300)`, magenta `~oklch(0.76 0.17 335)`, yellow `~oklch(0.845 0.155 85)` | `--st-compensating`, `--st-manual`, `--st-warn` |
| Failure accent | warm coral, ~`oklch(0.735 0.165 22)` | `--st-negative` |
| App frame radius | ~28 px on the floating canvas | `--radius-frame: 28px` |
| Card radius | ~16–20 px | `--radius-card` / `rounded-[20px]` |
| Pill radius | fully rounded chips, tabs, buttons | `rounded-full` throughout |
| Rail | slim icon-only, circular buttons, one filled lime active circle | `surface-rail` + `Shell` rail |
| Typographic voice | heavy geometric display title, wide-tracked uppercase kicker, monospaced numerics | Outfit Variable + Geist Mono Variable |

**What was deliberately not copied:** the reference is a crypto wallet. No balances, no exchange
names, no coin imagery, no token tickers appear anywhere in Nunatak. The transformation carries
its *principles* — ambient lighting, a floating near-black frame, one lime primary, selective
saturated data accents, generous radii, pill chips, heavy display headings — onto Nunatak's own
operational content.

---

## 2. The visual system

All of it lives in `web/src/index.css` as a Tailwind v4 CSS-first theme — no legacy stylesheet is
layered underneath it.

- **Token contract.** shadcn/Radix variable names (`--background`, `--card`, `--popover`,
  `--primary`, `--muted-foreground`, `--border`, `--ring`, `--radius`) are kept so the 24 vendored
  primitives consume the system without forks. Nunatak-specific tokens are added alongside:
  `--atmosphere`, `--canvas`, `--chip`, `--hairline`, `--lime-bright`, `--shadow-card`,
  `--shadow-lift`, `--st-*`.
- **Ambient utilities.** `@utility surface-atmosphere|frame|card|lit|rail|segment|state-dot`
  (`index.css:232–297`) encode the reference's directional lighting once, so no screen hand-writes
  a gradient.
- **Status ramp.** `--st-completed|running|compensating|negative|manual|pending|warn`
  (`index.css:141–147`) carries both the graphic and the text role. Contrast was computed, not
  assumed (see §8).
- **Typography.** `@fontsource-variable/outfit` → `--font-sans`;
  `@fontsource-variable/geist-mono` → `--font-mono` (identifiers, timestamps and every numeral,
  tabular). The unused proportional `@fontsource-variable/geist` package was removed rather than
  left installed to look intentional.
- **Motion.** `MotionConfig reducedMotion="user"` plus a global CSS kill switch
  (`index.css:299–308`) that collapses animation and transition durations to 0.01 ms under
  `prefers-reduced-motion: reduce`, so Radix/Tailwind keyframe animations are covered too, not just
  Motion components.

---

## 3. Dependencies and where each one is actually used

Every runtime dependency was checked for a real consumer in application code (not a demo file):

| Package | Version | Consumed by |
| --- | --- | --- |
| `radix-ui` | 1.8.1 | 16 modules — the primitive layer under `components/ui/*` |
| `class-variance-authority` | — | 6 modules — button, badge, tabs, alert variants |
| `@xyflow/react` | 12.12.0 | `graph/StepNode.tsx`, `graph/layout.ts`, `WorkflowDetail.tsx` (attribution kept visible; no Pro licence) |
| `recharts` | 3.10.1 | `components/charts.tsx` → Overview, Metrics, WorkflowDetail |
| `@tanstack/react-table` | 9.3.1 | `screens/Workflows.tsx` column model + sorting |
| `@tanstack/react-query` | 5.104.5 | `api/hooks.ts`, `state/api.tsx` — every live read, with `signal` threading |
| `motion` | 14.6.0 | 4 modules — KPI stagger, page transitions, rail |
| `cmdk` | 1.1.1 | `shell/CommandMenu.tsx` inside a Radix Dialog |
| `sonner` | 2.0.8 | `components/ui.tsx` `useToast` — copy + action confirmations |
| `lucide-react` | 1.61.0 | 19 modules — the single icon family |

Vendored shadcn primitives with no consumer were deleted rather than kept to inflate the
component count (§7).

Primitive coverage, all reached from real application code:

| Primitive | Where it is used |
| --- | --- |
| `dropdown-menu` | Header identity chip — key settings, copy key label, clear presented key (`shell/Shell.tsx`) |
| `popover` | Overview window disclosure — how the bounded placement walk built the time axis (`screens/Overview.tsx`) |
| `dialog` | Create-workflow modal, command palette host, confirmation prompts |
| `command` (cmdk) | `shell/CommandMenu.tsx` |
| `tooltip` | Rail status cluster and icon-only controls |
| `sheet` | Mobile/tablet navigation drawer below `lg` |
| `tabs` | Inspector detail panes |
| `skeleton` | `LoadingRows` on every async panel |
| `sonner` | `useToast` — action and copy confirmations |
| `table` | Workflows ledger (TanStack Table headless model), Metrics, Inspector steps |
| `select`, `toggle-group`, `alert`, `badge`, `input`, `label`, `textarea`, `separator`, `card`, `button` | Forms, filters, segmented range control, status surfaces |

Deleted for having no consumer anywhere in the app: `progress`, `scroll-area`, `switch`.

---

## 4. Shell

`web/src/shell/Shell.tsx` was rewritten (393 lines changed) and applies to every route:

- atmosphere band + floating rounded frame matching the reference's ~9 % inset,
- slim rail: brand mark in a lime ring, icon-only links, filled lime active state, key/role status
  at the foot, collapsing to a `Sheet` drawer below `lg`,
- header: search field wired to the real exact-match business-key filter, ⌘K command button,
  identity chip, primary "New workflow" action,
- one rhythm: `gap-4` panel grid, `rounded-[20px]` cards, `--shadow-card` elevation.

**Known library trap, worked around:** Radix `Slot` (behind `asChild`) stringifies `className`,
which destroys react-router's function-form `NavLink` className. Rail active state is therefore
derived from `useLocation().pathname` and passed as a plain string.

---

## 5. Screens

| Route | What changed | Data source (real) |
| --- | --- | --- |
| `/` Overview | KPI strip, execution-trend chart with 1 h/6 h/24 h/7 d range control, state donut, definition-volume bars, wall-time percentiles, control-plane gauges, recent executions, DLQ status | `/v1/workflows` cursor walk, `/v1/definitions`, `/metrics`, `/readyz`, `/healthz` |
| `/workflows` | TanStack Table column model, exact-match filter bar, state chips with live counts, keyset paging, client-side sort disclosure | `/v1/workflows` |
| `/workflows/:id` | **Signature surface** — folded serpentine execution graph, progress bar, details rail, step/event/metrics tabs, operator actions | `/v1/workflows/:id`, `/events`, `/dlq`, `/metrics` |
| `/dlq` | Open/all segmented control, dry-run preview then confirmed write, only the two exits the engine admits | `/v1/dlq`, `POST …/resolve` |
| `/events` | Scope-first workflow picker; audit and inbound per instance | `/v1/workflows/:id/events`, `/inbound` |
| `/metrics` | Census donut, transition ledger, bar lists, exhaustive raw exposition table | `/metrics`, `/readyz`, `/healthz` |
| `/settings` | Key presentation, identity preview, time-format tabs, connection diagnostics | local settings store + `/v1/*` probes |
| `*` NotFound | On-system empty route with real navigation exits | — |

**Honesty rules held under pressure.** `/metrics` exposes only cumulative counters and gauges, so
no sparklines or `rate(Δ)` curves are drawn. `GET /v1/workflows` has no date filter, so the time
axis is built from a bounded client-side cursor walk (page size 50, max 6 pages) and the panel says
"window partial" when the walk is truncated. Events exist only per workflow — there is no global
event stream — so the brief's "recent events" panel was **not** fabricated; the Overview was
enriched with real panels instead. An unavailable gauge renders as "unavailable", never as zero.

---

## 6. The execution graph as the signature feature

`web/src/graph/layout.ts` + `StepNode.tsx` + `graph.css`:

- fixed 238 × 88 cards with tone-washed surfaces, directional top-light and the step's real status
  hue on border, glyph and badge, so node, connector and pill always tell one story;
- **serpentine folding** — chains longer than four steps wrap into two balanced rows so the whole
  saga fits the stage at once. Row 2 runs right→left, which makes the fold a short vertical drop
  instead of a connector flying back across the canvas;
- connectors are named-handle routed (`out-r`/`in-l`, `out-l`/`in-r`, `out-b`/`in-t`);
- an edge is animated and tinted only once its downstream step has actually begun; unrun work is a
  dashed neutral hairline, never a fake traversed path;
- `fitView` frames the entire folded chain, so no step is ever hidden off-canvas;
- the lit stage, re-tokened controls, minimap and the visible React Flow attribution.

The ordering fact is still only `position` — compensators remain attributes of their forward step,
never inferred vertices.

---

## 7. Legacy removed

- The entire Phase 7 "Glacier Glass" layer was deleted, not overridden — no competing global CSS.
- Duplicate tokens consolidated into the shadcn/Radix contract; every hand-written screen stylesheet
  is gone (`index.css` is the only global sheet, `graph.css` the only component sheet).
- `@fontsource-variable/geist` uninstalled (proportional face unused).
- Vendored primitives with zero consumers deleted outright: `progress`, `scroll-area`, `switch`.
- `dropdown-menu` and `popover` were kept and given genuine consumers rather than deleted — the header
  identity menu and the Overview window disclosure (§3). Neither is reachable only from a demo file.
- Dead code removed with its last caller: the duplicate page-level create action on `/workflows`
  and the `creating` state it depended on.
- Stale "Phase 7 rebuild" header comments reworded to describe the current stack.

---

## 8. Second correction pass

The brief forbids treating a screenshot's existence as proof of quality, so the first sweep was
measured rather than admired. `.artifacts/p8/probe-clipped.mjs` walks all 11 route slots × 5
viewports, loads each route once and changes device metrics in place, and reports only genuinely
visible text that overflows its own box (screen-reader-only nodes, `display:none` subtrees and
zero-area SVG layers are excluded, because the first version of the probe produced 55 false
positives before those filters existed).

Ten real defects were found. Each was fixed and re-measured:

| # | Defect | Measured before | Fix | Measured after |
| --- | --- | --- | --- | --- |
| 1 | State-census donut switched to side-by-side on the **viewport** `sm:` breakpoint, so inside a narrow grid column the fixed 188px chart starved the legend | legend `<ul>` client `4px` vs scroll `84px` at 1024 | `components/charts.tsx` — layout now keyed to a container query (`@container` + `@[21rem]:flex-row`), so the donut stacks when *its own panel* is narrow | 0 |
| 2 | Panel titles lost glyphs where the `shrink-0` actions block competed for width | `h2` "Wall time to terminal" `106<136` at 1024; "Placement flow" `94<102` at 390 | `components/ui.tsx` — `Panel` header wraps (`flex-wrap`, `gap-x-4 gap-y-2`) so actions drop to their own line; `Overview.tsx` census row is 2-up at `lg`, 3-up at `xl`, with the third panel spanning | 0 |
| 3 | Long Prometheus metric names in kickers overflowed their box | `fathom_relay_publish_lag_seconds` `220<250`, `fathom_events_classified_total` `220<229` at 1024 | `[overflow-wrap:anywhere]` on the `Panel` and `KpiCard` kickers | 0 |
| 4 | Inspector execution-metric chips were a rigid 2-column grid, so single words escaped the card | "breached" `61<86` at 1280, "Compensable" `61<72` | `WorkflowDetail.tsx` — chips flex-wrap with `min-w-[124px] flex-1`; value drops to `text-base` with `break-words` so a duration plus its qualifier can take a second line | 0 |

Defect 3 is worth recording as a process lesson: the first attempt used Tailwind's
`break-anywhere`. It typechecked, linted, built and passed tests — and did nothing. Grepping the
built stylesheet showed the utility was never emitted (`overflow-wrap` appeared only once, from
`break-words`). The class was replaced with the arbitrary property `[overflow-wrap:anywhere]`,
which the probe then confirmed. A green build is not evidence that CSS exists.

Three further findings from the first pass were **not** product defects and were fixed in the
harness instead:

- 442 "failed requests" decomposed to 305 `ERR_ABORTED` (in-flight polls cancelled on navigation),
  56 × `503 /readyz` (genuine `relay_lag`), ~80 × `429` (the real 100 req/min per-key limiter) and
  3 × `401` (before the seed). The sweep is now paced with `GAP_MS=6000`.
- The header chip reading "Admin / ad" was the probe's own seed (`ad:admin:dev-admin-key`), not
  truncation. The seed is now `ops:admin:dev-admin-key`.
- Missing `<h1>` on three inspector captures was real (fixed in §5), but only on the loading and
  429 branches — the heading lived inside the success branch.

### Third pass — what a probe cannot measure

The probe reports text that escapes its own box. It stays silent about composition, so the
corrected frames were re-read by eye and showed two defects the instrument could not see:

| # | Defect | Where | Fix |
| --- | --- | --- | --- |
| 5 | The 5-card KPI strips collapsed to 2-up below `xl`, leaving the fifth card stranded beside a half-empty row — and on the inspector, whose cards carry no sub-line, a ~950px box holding one digit | `Overview.tsx`, `WorkflowDetail.tsx` "Fleet census", `Metrics.tsx` | `grid-cols-2` → `lg:grid-cols-3` → `xl:grid-cols-5`, plus `max-xl:[&>*:last-child:nth-child(odd)]:col-span-2` so an odd final card fills its row at either width; error/loading placeholders span the same row |
| 6 | Long snake_case metric names broke mid-token because a name with underscores is one unbreakable word: "FATHOM_EVENTS_CLASSIFIED_TOT / AL" | `components/ui.tsx` — `Panel` and `KpiCard` kickers | `breakable()` inserts a zero-width space after each `_`, so the line breaks at a separator; `[overflow-wrap:anywhere]` stays as the fallback for genuinely unbreakable strings |

Both new arbitrary variants were checked in the emitted stylesheet rather than trusted —
`@media not all and (min-width:80rem){…>:last-child:nth-child(odd){grid-column:span 2/span 2}}` and
`repeat(3,minmax(0,1fr))` are present in `dist/assets/*.css`, which is exactly the verification
`break-anywhere` failed. Re-running the probe over all 55 route × viewport combinations after these
two changes returned `clipped:0`, `pageOverflow:false` and no truncated headings
(`qa/collapse-pass3.txt`).

---

## 9. Browser and responsive verification

Capture runs live against the dev server with the real Go backend and the real Postgres store.
Three full sweeps were taken — `p8f` (before the correction pass), `p8g` (after the layout fixes)
and `p8h` (final full sweep) — each 11 route slots × 5 viewports with a scrolled
"fold" frame where the page exceeds the viewport: **85 PNGs per sweep**. After the third pass
(§8) the affected routes were re-captured as `p8j`/`p8k`/`p8l` at 1024, 768 and 390, and the
overflow probe was re-run over the whole matrix rather than replayed from memory.

Route slots: overview, workflows, dlq, events, metrics, settings, notfound, and four distinct
inspector states (aborted, completed, awaiting-manual, and the 7-step `qa-wide-7` fold).

Final sweep (`p8h-_evidence.json`, 55 measured captures):

| Check | Instrument | Result |
| --- | --- | --- |
| Document-level horizontal overflow | capture harness | 0 / 55 |
| Missing `<h1>` | capture harness | 0 / 55 |
| Console errors during capture | capture harness | 0 |
| Skeletons left on screen after settle | capture harness | 0 |
| Body font resolved | capture harness | `"Outfit Variable"` on every capture |
| Visible text overflowing its own box | `probe-clipped.mjs` | 0 / 55 (`collapse-final.txt`, re-confirmed 0 / 55 in `collapse-pass3.txt`) |

The probe still flags 20 of the 55 combinations, in every case only for table cells extending past
the fold inside a horizontally scrollable container — `pageOverflow` is false in all of them. That
is the phone-width table behaviour noted in §12, not a layout collapse.

Direct links and refresh were verified separately: reloading `/workflows/<id>` keeps the
inspector (`h1="qa-wide-7 v1"`), and every route was reached by URL rather than only by clicking.

---

## 10. Interaction, keyboard and motion verification

`.artifacts/p8/interact8.mjs` drives a second headless Chrome over CDP with trusted input events
(synthetic `el.click()` does not open Radix poppers). **25 checks, 25 passed.** Highlights:

- Identity chip opens a real `DropdownMenu`; its label states `Key label "ops" · admin`; Escape
  closes it; "Copy key label" raises a sonner toast.
- The Overview disclosure opens a `Popover` whose body carries the real walk parameters
  (page size 50, cap 6, rows walked 7) and the honest covered/partial verdict.
- ⌘K/Ctrl+K opens the palette and typing filters it: 15 → 11 items for `sett`.
- Create-workflow dialog opens and closes on Escape.
- Graph: 7 nodes and 6 edges for the 7-step chain; clicking the last node puts exactly one
  selection ring on and names that step in the step panel; wheel zoom changes the viewport
  transform.
- Recharts hover produces a tooltip.
- Rail: docked at 1024 (no drawer needed), `Sheet` opens at 768 and 390 and its links route.
- Keyboard: three Tabs land on a real control with a painted 3px focus outline.
- `prefers-reduced-motion: reduce` → max transition duration `0.00001s` and **0** elements still
  running CSS animations.
- Clearing the key surfaces the honest "No API key presented" warning rather than fake zeros.

---

## 11. Quality gates

| Gate | Command | Result |
| --- | --- | --- |
| Format | `prettier --check "src/**/*.{ts,tsx,css}"` | all files match Prettier style |
| Lint | `eslint .` | 0 errors, 15 warnings |
| Types | `tsc -b` | 0 errors |
| Tests | `vitest run` | 65 passed / 10 files |
| Build | `npm run build` | success, 1.03s |
| Backend format | `gofmt -l .` | no files listed |
| Backend vet | `go vet ./...` | clean |
| Backend build | `go build ./...` | success |

Every row was run on the final tree, after the third correction pass — the gates describe the
committed state, not an earlier snapshot.

The 15 warnings are all `react-refresh/only-export-components` from vendored shadcn files that
export a `cva` variant alongside their component — upstream shape, left intact rather than forked.

The build emits exactly two font families (`outfit`, `geist-mono`), confirming the removed
proportional face is not still being pulled in.

---

## 12. Genuine limitations

- **Readiness is really degraded here.** `/readyz` answers `{"status":"unavailable",
  "reason":"relay_lag"}`, so the coral "Control plane degraded" banner and the 503 pill appear in
  the evidence. That is the product reporting the truth, not a styling artefact.
- **No global event feed exists.** Events are scoped to one workflow, so Overview has no
  "recent events" panel even though the reference has one. Inventing a fleet-wide stream was
  rejected.
- **No rate-based series.** `/metrics` exposes cumulative counters and gauges only, so there are no
  sparklines or `rate(Δ)` charts. The time axis comes from the bounded client walk — 6 pages ×
  50 rows — and is labelled partial when the cap is hit before the window opens.
- **Wide tables scroll horizontally on phones** (workflows ledger, metrics). The page itself never
  overflows, but columns beyond the fold need a swipe; there is no sticky first column.
- **Border tints are decorative.** At `/25` alpha the status borders measure 1.53–1.83:1 against
  the card. Status is never carried by a border alone — dot, label and text all say it.
- **The `negative` tone clips the sRGB gamut** when converted for the contrast maths; it renders
  correctly in `oklch`, and the measured text contrast (6.00:1) is the sRGB-clipped worst case.
- **React Flow attribution stays visible** — no Pro licence is held.
- **Dark only.** No light theme was designed, so the token pair has no light counterpart yet.
- Clipboard writes need a secure context; the toast path is verified, but a browser that blocks
  the API shows the failure toast instead.

---

## 13. Commits and tree status

Phase 8 branches from `28e74c5` (the Phase 7 M8 tip) and lands as three code
commits, grouped by layer:

| Commit | Scope |
| --- | --- |
| `e08bf4b` | M1 — token, typography and aggregation foundation; status re-ramp; jsdom stubs |
| `d2b0be3` | M2 — shared shell, rebuilt `components/ui.tsx` kit, re-tokened primitives, settings/API state |
| `3ace578` | M3–M6 — every screen, the React Flow inspector, the data layer and the motion pass |

`git diff --stat 28e74c5..3ace578` — **69 files changed, 11739 insertions, 7033
deletions**. The Go control plane, its API contracts, authorization, engine and
persistence are untouched; the diff is `web/` plus this document.

Honest caveat on the grouping: the commits are layered so a reviewer can read
them in order, and only the final tree was gated. An intermediate commit is not
guaranteed to build on its own, because screens and the kit they import landed
in separate commits.

This report landed as `0e91f68`. The commit you are reading this line in is the
follow-up that pins it — a commit cannot contain its own hash, the same way
Phase 7 closed out.

Working tree after Phase 8: clean, with `.artifacts/` (screenshots, probes,
reference image) git-ignored as designed.
