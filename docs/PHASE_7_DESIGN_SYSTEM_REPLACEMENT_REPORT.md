# Phase 7 — Design System Replacement Report

**Date:** 2026-10-24 · **Branch:** `main` · **Operator session:** Qoder
**Scope executed:** the frontend design system was replaced end to end — tokens, typography,
surfaces, semantic state colour, controls, icons, charts, graph, animation, accessibility —
and every route was rebuilt on the new stack. Backend, API contracts, engine semantics, auth
behaviour and real data were treated as frozen.

**Verdict:** complete, with **seven items of declared remaining work** (§11) — two of which need
a backend or durable-engine change and were therefore out of Phase 7 scope. All gates were run;
§10 reports twelve rows covering the brief's ten, including the one gate this repository cannot
support, and records a **pre-existing tooling defect found and fixed** at gate 3.

---

## 1. Real baseline (what Phase 6.7 actually shipped)

Measured from `bbaffe4` (*Phase 6.7: visual acceptance audit*), not from a description:

| Baseline fact | Measured value |
| --- | --- |
| Stylesheets in `web/src` | 8 — `theme/tokens.css`, `theme/base.css`, `components/ui.css`, `components/charts.css`, `screens/screens.css`, `shell/shell.css`, `shell/command.css`, `graph/graph.css` |
| Hand-written CSS lines | 3,564 raw across the eight stylesheets; the two largest alone are `screens.css` 1,594 and `ui.css` 380 (1,974 together, 1,848 excluding blanks and comments) |
| Unique class selectors | 443 distinct class names in selector positions (comments stripped, text before each `{`), across the eight stylesheets — 448 if every `.name` token anywhere in the files is counted |
| Design tokens | 69 `--fx-*` custom properties in `theme/tokens.css` (121 lines) |
| Icon system | `web/src/icons/index.tsx` — 42 hand-drawn `Icon*` React components + the `NunatakMark` brand mark (43 exports, 323 lines) |
| Primitive components | hand-rolled kit in `components/ui.tsx` (no Radix, no cva) |
| Charting | bespoke SVG in `components/charts.tsx` + `charts.css` |
| Ledger | hand-built `<table>` with ad-hoc sort state |
| Motion | CSS keyframes + `motion` used only in the palette/shell |
| Typography | Inter + JetBrains Mono + Space Grotesk (3 families, 2 scales) |
| Accessibility | never measured; state ramp `--fx-st-*` at L 0.66–0.8 |

That baseline was the **audit reference**, not the foundation: Phase 7 replaced it rather
than extending it. Nothing from the `fx-*` layer survives — §9 shows how that was verified.

---

## 2. Toolkit investigation (integrity rules applied)

Rules honoured throughout: an npm package is not an MCP server; an MCP server is not a
registry; a registry is not a remote platform; nothing is claimed as connected because a
package is installed; nothing is claimed as implemented because it appears in
`package.json`; no tool access was invented; nothing was purchased.

### 2.1 What is actually connected in this session

Authoritative current MCP set (from the session's tool registry, not inferred):

| Server | Tools | Used in Phase 7 |
| --- | --- | --- |
| `browser-use` | 16 (navigate, click, fill, press_key, take_screenshot, take_snapshot, evaluate_script, list_network_requests, list_console_messages, …) | available; the QA harness in §10 drove raw CDP instead, because it needed `Emulation.setDeviceMetricsOverride`, emulated media and trusted input events |
| `extension-market` | 2 (`search_extensions`, `install_extension`) | used **read-only** for the market investigation below; `install_extension` was never called |
| `plugin:qoder-qmind` | 7 (knowledge base retrieval/import) | not relevant to this phase, not used |

There is **no repo-local MCP configuration**: no `.qoder/`, no `.mcp.json`, no
`.well-known/` server file in `fathom-workflow`. Connected servers are a property of the
operator's desktop, not of the project.

### 2.2 Market findings (re-run 2026-10-24, quoted from responses)

| Query | Kind | Result | Consequence |
| --- | --- | --- | --- |
| `figma` | mcp | 1 item — `Figma` v1.0.0, `installed: false`, `configurationRequired: true`, `enabledForAgent: false` | **Figma MCP is not connected and was not used.** No design file was read. |
| `context7` | mcp | 1 item — `Context7` v1.0.5, `installed: false` | **Context7 not connected.** Library APIs were read from the installed packages' own `.d.ts`/dist, not from a docs MCP. |
| `penpot` | mcp | 0 items | Penpot MCP is not offered by the connected market; not used. |
| `design components ui library` | mcp+skill | 0 items | No Magic UI / 21st.dev / component-registry connector exists here. Registry components were therefore **authored locally through the shadcn CLI convention** rather than pulled from a remote registry. |
| `browser screenshot page automation` | mcp+skill+plugin | 0 items | The `browser-use` server above is a session server, not a market result — reported separately to avoid conflating the two. |
| `storybook` | mcp / skill / plugin | 0 / **12** / 0 | Storybook exists only as *Skills* (none installed). **Storybook is not installed, no `.storybook/` exists, and no story file was written** — so no component is claimed "Storybook-verified". |

### 2.3 Libraries from the Phase 7 brief — installed or not (verified against `web/package.json`, the lockfile and `node_modules`)

**Installed and genuinely used:** Tailwind v4 (`tailwindcss`, `@tailwindcss/vite`), `radix-ui`
(meta-package), shadcn/ui sources vendored into `web/src/components/ui/`, `class-variance-authority`,
`clsx`, `tailwind-merge`, `lucide-react`, `@xyflow/react`, `recharts`, `@tanstack/react-table`,
`@tanstack/react-query`, `motion`, `cmdk`, `sonner`, `@fontsource-variable/geist`,
`@fontsource-variable/geist-mono`.

**Not installed, not used (probed in `node_modules`, absent from the lockfile):**
GSAP, Three.js, `@react-three/fiber`, `@react-three/drei`, R3F, `@rive-app/react-canvas`,
`lottie-react`, Lenis, Flowbite, `@tremor/react`, React Bits, Aceternity UI, Storybook,
PixiJS. (`framer-motion`, `d3-zoom` and `@radix-ui/react-dialog` *are* present but only as
**transitive** dependencies of `motion`, `@xyflow/system` and `radix-ui`/`cmdk` respectively —
verified with `npm ls`; no source file imports them directly.)

**Remote platforms** (Runway, Luma, fal, Replicate, FLUX, Recraft, Kling, Pika, Krea, Meshy,
Tripo, Canva, Webflow, Framer): **no credentials in this environment** — an
environment scan for `FAL_ / REPLICATE / RUNWAY / KLING / PIKA / KREA / TRIPO / MESHY / FIGMA /
CANVA / WEBFLOW / FRAMER / LUMA` variables returned none, and no CLI for any of them is
configured. Nothing was generated, downloaded or purchased from them, and no asset in the
bundle originates from them.

**Blender 4.5.0 is installed locally** (`E:/Blender/blender-4.5.0`) and was **deliberately not
used**: the cockpit has no 3D surface, and `web/public` ships exactly one asset
(`nunatak.svg`). No `.glb/.gltf/.fbx/.mp4/.webm/.png/.jpg` is referenced anywhere in
`web/src`.

**Figma / Penpot design files:** none reachable (§2.2), so art direction came from written
direction + iterative in-browser measurement, not from a design-source round-trip.

---

## 3. What replaced what — migration map

| Legacy (Phase 6.7) | New (Phase 7) | Notes |
| --- | --- | --- |
| `theme/tokens.css` 69 × `--fx-*` | `web/src/index.css` — Tailwind v4 `@theme inline` contract over `--background/--card/--primary/--st-*/--chart-*` | tokens are the shadcn/Radix contract names, so vendored components work unmodified |
| `theme/base.css`, `components/ui.css`, `screens/screens.css`, `shell/shell.css`, `shell/command.css`, `components/charts.css` | deleted; replaced by Tailwind utilities + three `@utility` recipes (`surface-card`, `surface-veil`, `state-dot`) | 3,354 CSS lines deleted outright (seven files, `git diff --numstat bbaffe4..HEAD`); `graph.css` rewritten 210 → 68; only `index.css` (209 lines) and `graph/graph.css` (68 lines) remain |
| `--fx-font-display / -ui / -mono` (Space Grotesk, Inter, JetBrains Mono) | `--font-sans: Geist Variable`, `--font-mono: Geist Mono Variable` | two families instead of three; self-hosted via Fontsource, no remote font request |
| `--fx-fs-*` 7-step scale + `text-rendering` tweaks | Tailwind type scale + deliberate `13px` root density in `@layer base` | density carried over from the retired cockpit scale |
| `--fx-panel / --fx-panel-raised / --fx-void / --fx-ink-*` | `--card`, `--popover`, `--abyss`, `--foreground`, `--muted`, `--ice` | surface language rebuilt as frost-on-ink layers |
| `--fx-st-completed 0.78 / -negative 0.66 / -warn 0.8 …` | `--st-completed 0.83 0.12 168`, `--st-running 0.83 0.11 205`, `--st-compensating 0.84 0.13 295`, `--st-negative 0.83 0.14 15`, `--st-manual 0.84 0.13 42`, `--st-pending 0.8 0.015 240`, `--st-warn 0.85 0.13 85` | one ramp serving both graphic (3:1) and text (4.5:1) roles — see §9 |
| `--fx-r-sm/md/lg/pill`, `--fx-shadow-*`, `--fx-line-*`, `--fx-sp-*` | `--radius-sm…xl` on one `--radius`, `shadow-xs/md`, `--border/--input`, Tailwind spacing | no parallel scale left behind |
| `--fx-dur-fast/-slow`, `--fx-ease` | `transition-*` utilities + `MotionConfig reducedMotion="user"` + the global `prefers-reduced-motion` block | motion is data-driven, and neutralised under reduced motion (gate 8) |
| 42 hand-drawn `Icon*` components (`web/src/icons/index.tsx`) | `lucide-react` — 51 distinct icons across 19 files | one stroke grammar, tree-shaken, ISC-licensed |
| `components/ui.tsx` hand-rolled kit | kit preserved as the **app-level** vocabulary (`Panel`, `PageHeader`, `KpiCard`, `StatusBadge`, `EmptyState`, `ErrorState`, `LoadingRows`, `Pager`, `ConfirmAction`, `SnapshotAt`, `TimeText`, `RelTime`, `CopyChip`, `useCursorStack`, `useToast`) composed on 24 vendored shadcn primitives | kit API/semantics unchanged so screens kept their honesty rules |
| bespoke SVG charts (`components/charts.tsx` + `charts.css`) | `components/charts.tsx` on Recharts (line/area/bar/donut + real axes, tooltips, legend) | same file name, new engine |
| hand-built ledger table | `@tanstack/react-table` column model + shadcn `Table` | sorting is client-side over the loaded page and **says so** in the footer |
| `.fx-graph`, `.fx-node--running`, `fx-keyspec`, `fx-def-*` DOM ids | `.flow-stage`, `.flow-node--running`, `key-spec`, `definition-name/version/steps` | the last identifiers inherited from the retired layer |

**Physical removal verified:** `grep -rn "fx-" web/src` now returns only three prose comments
that *describe* the retirement. No `fx-` token, class, selector, id or file remains.

---

## 4. Art direction delivered

"Cinematic workflow-orchestration command center", implemented as **Glacier Glass**: deep
glacial ink (`--abyss`/`--background` at oklch 0.128), frost-white type, glacier-teal primary
with ice-violet secondary, top-lit frost surfaces (`surface-card` inset highlight + long soft
shadow, `surface-veil` aurora behind chrome only), Geist/Geist Mono for a technical register,
and engine state semantics as the *only* chromatic accent in data surfaces. Density is
deliberate (13px root, tabular mono numerals). No decorative element carries information the
API does not provide: no fake sparkline, no invented branch in the graph, no CPU/memory gauge
the engine does not expose, no colour without a co-rendered label.

---

## 5. Route-by-route rebuild and verification

Routes (from `web/src/App.tsx`): `/`, `/workflows`, `/workflows/:id`, `/dlq`, `/events`,
`/metrics`, `/settings`, `*` (404). Shell: rail + mobile sheet, header search, ⌘K palette,
create-workflow dialog, role/key chip, no-key banner.

| Route | Rebuilt on | Browser evidence (32-check sweep) |
| --- | --- | --- |
| Overview `/` | kit KPI strip (motion-staggered), Recharts census donut, activity feed, lease/DLQ telemetry | landmark check `{"header":6,"main":1,"nav":1,"h1":1}`; contrast pass at 1536 and 390 |
| Workflows `/workflows` | TanStack Table + shadcn Table, keyset pager (`useCursorStack`), state + exact business-key filters, census-annotated filter bar | `state filter narrows the ledger — 7 → 1 rows`; `a column header is sortable — first=Aborted`; `rows link to a real inspector route` |
| Inspector `/workflows/:id` | React Flow graph (`graph/layout.ts` deterministic chain, `StepNode.tsx`), progress bar, step rail, tabs, event log, attempt gantt, cancel/retry verbs with dry-run + confirm | `deep link renders the workflow page — echo-compensate v1`; `survives a hard reload — nodes=2`; `clicking a node rings it and drives the step detail rail`; `clicking the same node again clears the selection`; `zoom control changes the viewport transform — scale(1) → scale(1.2)`; `step rail is keyboard navigable — rail steps=2`; `React Flow attribution is visible (licence)` |
| Dead letter `/dlq` | kit Panels + `ConfirmAction`, dry-run preview first, only the two W17 exits (force-terminate, complete-compensation), `retry-now` deliberately absent | live queue was **empty**, so verbs could not be exercised in the browser; covered by 5 unit tests instead (§10 gate 4, §11 gap 1) |
| Events & Audit `/events` | audit ledger + inbound stream tabs, workflow quick-pick, cursor paging, seq/type chips | `bare route offers a real workflow quick-pick — picks=7`; `deep-linked audit ledger renders real rows — rows=6`; `switching to the inbound source keeps the page live` |
| Metrics & Health `/metrics` | Recharts line/area/bar over real Prometheus families, `/healthz` + honest `/readyz` 503, DLQ depth by class | `charts draw from real series — shapes=10`; `no fabricated sparklines when history is absent — series rendered = 6` |
| Settings `/settings` | shadcn Tabs/Field/Switch, connection probes, key-spec validation + identity preview, definitions registry + admin-only register | `clock preference changes rendered timestamps — utc "23 Oct 2026, 15:29:12 UTC" / local "23 Oct 2026, 20:59:12"`; `readiness probe reports the real 503 reason`; `re-probe re-runs without breaking the page` |
| 404 `*` | kit EmptyState + real navigation | `honest not-found with real navigation — h1="This route doesn't exist" links=6` |
| Create-workflow dialog | shadcn Dialog + real `/v1/definitions` | `dialog lists real definitions`; `definition list is populated from /v1/definitions — options=3`; `cancel dismisses the dialog` |
| Shared states | `LoadingRows`, `EmptyState`, `ErrorState` (401/403/429/409/transport split honestly), offline/degraded banners | `ErrorState` contract tests in `components/ui.test.tsx` |
| Shell / palette | rail + `Sheet`, `cmdk` palette, `MotionConfig`, skip-link | `rail renders the real destinations — links=6`; `'/': focuses the header search`; `submitting routes to the workflows ledger — /workflows`; `⌘K opens the command menu — overlays=1`; `Escape closes it — overlays=0` |

**Deep links and refresh:** the inspector deep link was loaded directly and then hard-reloaded
(`nodes=2` after reload); the events deep link (`?workflow=<id>`) was loaded directly. Both
recovered real data, no client-side route error.

**Screenshots:** `before/` = the Phase 6.7 acceptance set `.artifacts/p67/audit-<route>@<vp>.png`
— 8 routes × 5 viewports = **40 shots**. `after/` = `.artifacts/p7/final3/p7final3-<route>@<vp>.png`
— 11 routes × 5 viewports = **55 full-page shots plus 30 fold-height crops (85 files)**. 40
before/after pairs are directly comparable; the 15 after-only frames cover `insp-manual`,
`insp-wide` and `notfound`, which the 6.7 audit did not capture. Capture sweep result line:
`55 shots | consoleErrors: 0 | overflow: none`. `final3` **supersedes** `final2` (captured before
the gate-3 cleanup removed the emitted `.js` twins); the two agree on `docH` for all 55 frames, so
the earlier set is corroborating rather than contradicted.

---

## 6. Implementation matrix (actual use, not package presence)

| Library or tool | Installed / connected | Actual source component or API | Files using it | User-visible functionality | Verification |
| --- | --- | --- | --- | --- | --- |
| Tailwind v4 | `tailwindcss` + `@tailwindcss/vite` ^4.3.3 | `@import "tailwindcss"`, `@theme inline`, `@utility`, `@custom-variant dark` in `web/src/index.css`; wired in `vite.config.ts` | every `.tsx` (utilities) + `index.css` | the entire visual system | `vite build` emits the compiled sheet; contrast audit resolves utilities in-browser |
| shadcn/ui + Radix | `radix-ui` ^1.8.1; 24 vendored components | `Button`, `Badge`, `Input`, `Textarea`, `Label`, `Select`, `Switch`, `Tabs`, `Dialog`, `Sheet`, `Popover`, `Tooltip`, `DropdownMenu`, `Command`, `Table`, `Progress`, `Skeleton`, `ScrollArea`, `Separator`, `Toggle(+Group)`, `Alert`, `Card`, `Sonner` | `web/src/components/ui/*` (24 files); consumers in 16 files | every control surface: dialogs, palette, sheets, tabs, toasts, forms | `ui.test.tsx`, `dlq.test.tsx`, `settings.test.tsx`, `CommandMenu.test.tsx`; browser sweep (§5) |
| class-variance-authority | ^0.7.1 (Apache-2.0) | `cva(...)` + `VariantProps` in `button.tsx`, `badge.tsx`, `alert.tsx`, `input.tsx`, `textarea.tsx`, `toggle.tsx` | 6 files | variant-driven control styling | typecheck + rendered `data-variant` assertions in tests |
| clsx + tailwind-merge | ^2.1.1 / ^3.7.0 | `cn()` in `web/src/lib/utils.ts` | 1 file, used app-wide | deterministic class de-duplication | unit tests assert merged class strings |
| lucide-react | ^1.61.0 (ISC) | 51 distinct icon imports | 19 files | nav, verbs, status markers, empty states | browser sweep + `rg` count |
| @xyflow/react | 12.12.0 (MIT) | `ReactFlow`, `Handle`, `useNodesState/useEdgesState`, `Background`, `Controls`, `MiniMap`, `fitView`, `applyNodeChanges`; `@xyflow/react/dist/style.css` re-tokened in `graph/graph.css` | `graph/graph.css`, `graph/layout.ts`, `graph/StepNode.tsx`, `screens/WorkflowDetail.tsx` | execution inspector graph, zoom/pan, minimap, node selection driving the step rail | 5 graph checks in the sweep, incl. attribution badge visible (licence) |
| Recharts | ^3.10.1 (MIT) | `LineChart/AreaChart/BarChart/PieChart/RadialBarChart` + `XAxis/YAxis/Tooltip/ResponsiveContainer` | `components/charts.tsx` (imported by `screens/Overview.tsx`, `screens/Metrics.tsx`) | throughput/latency trends, census donut, DLQ depth by class, gauge tiles | `charts draw from real series — shapes=10`; `no fabricated sparklines when history is absent` |
| @tanstack/react-table | ^9.3.1 (MIT) — via the package's `legacy` React entry | `useLegacyTable`, `getCoreRowModel`, `getSortedRowModel`, `flexRender`, `LegacyColumnDef`, `SortingState` | `screens/Workflows.tsx` | sortable column model over the loaded page | `a column header is sortable — first=Aborted`; §11 records the `legacy`-entry compromise |
| TanStack Query | 5.104.5 | `useQuery`/`useMutation` with `signal` threading in `api/hooks.ts` | 2 files (`api/hooks.ts`, `state/api.tsx`) + all screens | caching, refetch, re-probe, abort-on-unmount | sweep's re-probe check; `net::ERR_ABORTED` profile in §10 |
| motion | ^14.6.0 | `MotionConfig reducedMotion="user"`, `AnimatePresence`, `motion.div` page transitions, KPI stagger | `App.tsx`, `components/ui.tsx`, `shell/Shell.tsx` | route transitions, telemetry reveal | `reduced-motion: transitions/animations neutralised — elements still animating=0` |
| cmdk | ^1.1.1 | `Command.Input/List/Item/Group/Dialog` in `components/ui/command.tsx` | `components/ui/command.tsx`, `shell/CommandMenu.tsx` | ⌘K palette with real routes + recent workflows | `⌘K opens the command menu`, `Escape closes it`; `CommandMenu.test.tsx` (4 tests) |
| sonner | ^2.0.8 | `toast()` + `Toaster` in `components/ui/sonner.tsx`, wrapped by kit `useToast` | `components/ui/sonner.tsx`, `components/ui.tsx` | write-confirmation toasts (resolved, cleared key, created workflow) | `dlq.test.tsx`, `settings.test.tsx` |
| Geist / Geist Mono | `@fontsource-variable/geist(-mono)` ^5.3.0, OFL-1.1 | `import "@fontsource-variable/geist…"` in `main.tsx`; bound to `--font-sans/--font-mono` | `main.tsx`, `index.css` | all type; mono for ids, numerals, timestamps | `dist/assets/*.woff2` present after build; no remote font request |
| React Bits / Aceternity / Magic UI / 21st.dev / Flowbite / Tremor / GSAP / Three / R3F / Drei / Rive / Lottie / Lenis / Storybook / Penpot / Figma MCP / Context7 MCP | **not installed / not connected** (§2) | — | — | — | reported as absent; **no** claim of use |

---

## 7. Cleanup performed

* Deleted `web/src/screens/screens.css` (1,594 lines), `web/src/components/ui.css` (380),
  `web/src/theme/tokens.css` + `base.css`, `web/src/shell/shell.css`, `web/src/shell/command.css`,
  `web/src/components/charts.css`, `web/src/icons/index.tsx` (42 hand-drawn `Icon*` components), `web/public/alpine.svg`.
* Removed dependencies that no longer serve the app: `@fontsource-variable/inter`,
  `@fontsource-variable/jetbrains-mono`, `@fontsource-variable/space-grotesk`, `next-themes`
  (the cockpit is dark-only, no theme switch), and the stray `cn@0.5.0` package (the local
  `cn()` helper in `web/src/lib/utils.ts` is the real one).
* Removed the **64 compiled `.js` twins** the broken `typecheck` script had emitted into
  `web/src` (gate 3). Each was verified as the exact compiled twin of a tracked `.ts/.tsx`
  source before deletion (`git clean -n` reviewed file-by-file, zero orphans), and the script is
  now plain `tsc -b`, so the source tree cannot accumulate build output again.
* One card language (`surface-card`), one state ramp (`--st-*` + `TONE`), one icon set, one
  chart engine, one graph engine, one primitive kit — no parallel old/new path.
* Retired the last legacy identifiers: `.fx-graph`→`.flow-stage`, `.fx-node--running`→
  `.flow-node--running`, `fx-keyspec*`/`fx-def-*` DOM ids → `key-spec*`/`definition-*`.
* Docs updated as part of the phase: `docs/ASSET_ATTRIBUTION.md` (rewritten for Geist/lucide,
  reviewed against the Phase 7 tree), `docs/ATTRIBUTION_AND_LICENSES.md` §3 (frontend licences
  re-read from registry metadata, plus the corrected React Flow attribution posture),
  `docs/OBSERVABILITY_AND_UI_SPECIFICATION.md` Phase 7 addendum, `README.md`.
* `.artifacts/` QA harnesses stay **git-ignored** (`.gitignore:54`); nothing in it is committed.

---

## 8. Why the two "extra" systems were kept, explicitly

* **React Flow attribution badge: rendered.** Removing it requires React Flow Pro, which this
  project does not hold. It is re-tokened into the system (`graph/graph.css`) instead of
  hidden, and the sweep asserts it stays visible.
* **TanStack Table `legacy` entry: used.** v9's React wrapper is the compatibility API
  (`useLegacyTable`/`LegacyColumnDef`). The ledger works and is measured; migrating to the v9
  experimental API is recorded as remaining work (§11), not silently done.

---

## 9. Accessibility: the measured pass (this is where Phase 7 was actually hard)

The contrast audit resolves every colour **through the browser** (paint → 1 px canvas →
`getImageData`), composites the full ancestor background chain including gradient stops, and
scores each visible text node against its **worst** composited background. Hand-parsing
`getComputedStyle` colours is not sufficient: Chrome serialises authored `oklch()` through
`oklab()`/`color(srgb …)`, which silently broke the first implementation and produced a
false 1.13 ratio.

| Stage | Offenders (16 route × viewport runs, 1,406 text nodes) |
| --- | --- |
| Phase 6.7 ramp, before Phase 7 measurement | 2.6–3.9 as text on the ramps' own surfaces (systemic) |
| After the first Phase 7 ramp | ~200+ across the sweep (badge text on own tint, muted-on-frost) |
| After badge/nav recipe change + ramp lift | 45 |
| **Final** | **0** — re-measured after the gate-3 cleanup on the corrected `.tsx` graph: 16 runs, 1,406 nodes, `TOTAL offenders: 0` |

Five defect classes and their fixes, each measured:

1. **Active nav item** — `text-primary` on its own `bg-primary/12` tint = **3.90**. Hue moved
   into the tint/ring and the **icon**; the label is frost `text-foreground` (now ≈6.3).
2. **State badges** — same-tone label on same-tone 10% tint capped near **4.3** even at the
   lightest in-gamut value (sRGB clipping). `TONE[*].badge` now paints `text-foreground` with
   hue in `border-*/35`, `bg-*/10` and the dot; `Dlq.tsx`'s hand-rolled class chip was
   switched to `TONE.manual` so no screen drifts from the recipe.
3. **Secondary text on frost stacks** — `--muted-foreground` **3.78** where `bg-ice` sits
   inside a `surface-card` panel (the 4% + 6% white veil lifts the surface to ~8%). Raised to
   `oklch(0.85 0.02 235)`, one step under `--foreground`, keeping the hierarchy (1.38×) while
   clearing AA on the lightest stack.
4. **Destructive roles** — `--destructive` was doing two contradictory jobs. Bright 0.65 reads
   as a border/ring on ink but cannot carry near-white text (ink measured **4.50** on
   `bg-destructive/60`, lower on the solid). Split: `--destructive` (borders, rings, invalid
   states) vs **`--destructive-fill: oklch(0.54 0.18 15)`** for filled controls → ink **5.25**,
   fill-vs-card 3.4. Destructive *alerts* moved to the `--st-negative` ramp (3.87/3.59 → 6.1).
5. **Role avatar chip** — teal-on-teal 3.58 became a filled `bg-primary` chip with
   `text-primary-foreground` (and `bg-st-warn text-background` when no key is presented).

One documented exemption was added to the harness, not to the app: text inside **disabled**
controls is skipped, per WCAG 1.4.3's own carve-out for inactive UI components. Enabled
states are scored strictly. Reduced motion is verified app-wide (`elements still animating=0`
under `prefers-reduced-motion: reduce`), as is landmark structure (single `h1`, one `main`,
one `nav`), keyboard reachability of the step rail, and `aria-describedby`-linked field errors.

---

## 10. Quality gates

| # | Gate | Result |
| --- | --- | --- |
| 1 | Format | **Not available — honestly reported.** The repo has `.editorconfig` (`end_of_line = lf`) but **no formatter is configured**: `web/package.json` exposes only `dev/build/preview/lint/test/typecheck`, and there is no Prettier/dprint/Biome dependency or config anywhere in the project. Introducing one would rewrite all ~90 source files with whitespace noise, so none was added. *Manual note:* committed files are CRLF in the working tree; the CRLF→LF damage caused once by `sed -i` during this phase was detected in `git diff` and reverted byte-for-byte, leaving a 94-insert/57-delete content diff instead of a 3,400-line one. |
| 2 | Lint | `eslint .` → **0 errors, 15 warnings**, all `react-refresh/only-export-components` (vendored shadcn `tabs/toggle/alert`, plus `state/api.tsx` and `state/settings.tsx` exporting hooks alongside providers). Pre-existing, not introduced, and HMR-only in nature. |
| 3 | Typecheck | **Clean — but the gate script itself was broken, and Phase 7 fixed it.** `npm run typecheck` shipped (since `20a1e5c`, Phase 6) as `tsc -b --noEmit false --emitDeclarationOnly false`. Under TypeScript 5 that exits non-zero with two config errors — `TS5096: Option 'allowImportingTsExtensions' can only be used when either 'noEmit' or 'emitDeclarationOnly' is set` — *and* the flags override the configs' own `"noEmit": true`, so the run **compiled 64 `.js` twins into `web/src`** (including `web/vite.config.js`). Because Vite's default `resolve.extensions` orders `.js` **before** `.ts/.tsx`, extensionless imports could resolve to those twins instead of the real sources. Corrected to `"typecheck": "tsc -b"` (both `tsconfig.app.json` and `tsconfig.node.json` already declare `noEmit`), deleted all 64 twins, and re-ran: `tsc -b` and `tsc -b --force` → **exit 0, zero output files**. Every browser verification below was then executed again against the corrected module graph (fresh dev server, verified serving `/src/App.tsx`): **32/32 checks pass, contrast offenders 0**. |
| 4 | Unit tests | **51 tests in 9 files, all passing**: `api/guards.test.ts`, `api/prom.test.ts`, `components/ui.test.tsx` (6), `graph/layout.test.ts`, `screens/dlq.test.tsx` (5), `screens/settings.test.tsx` (9), `shell/CommandMenu.test.tsx` (4), `state/settings.test.ts`, `theme/status.test.ts`. |
| 5 | Tests for migrated components | StatusBadge recipe + `ErrorState` honesty (401 vs 403 vs transport), Settings probes/key-spec validation/registry gate, DLQ dry-run→confirm→reason-required→reader-key, CommandMenu navigation. |
| 6 | Production build | `npm run build` (`tsc -b && vite build`) → success in **935 ms**. Bundle `dist/assets/index-36JBis63.js` **1,429.89 kB (gzip 427.83 kB)**; Vite's >500 kB chunk warning persists (React Flow + Recharts + TanStack in one entry) — recorded, not hidden. This is the post-cleanup build: with the 64 emitted `.js` twins gone (gate 3), the graph provably contains only the `.ts/.tsx` sources. |
| 7 | Launch and exercise every route | Vite dev + `fathom.exe` (`mode all`) against the real Postgres; 7 routes + 404, deep links, hard reload, refresh, filters, sort, dialog, palette, keyboard. **32/32 checks pass**, e.g. `inspector: survives a hard reload — nodes=2`. |
| 8 | Screenshots, 5 viewports | 1536 / 1280 / 1024 / 768 / 390 × 11 routes → **55 full-page + 30 fold shots** (`.artifacts/p7/final3/`), result line `55 shots \| consoleErrors: 0 \| overflow: none`. Re-captured after the gate-3 cleanup; **`docH` matches the earlier `final2` set on all 55 frames** (e.g. overview 1202, metrics 2250, insp-wide@390 3348), which proves the deleted `.js` twins were current and both capture sets are valid evidence. 7 early frames were skeleton-starved and re-shot with `SETTLE_MS=5200`. |
| 9 | Inspect desktop + mobile, fix defects | Defects found and **fixed**: contrast (§9), nav label legibility, DLQ chip recipe divergence, destructive ink, role chip. Mobile: rail collapses to `Sheet`, close control labelled, header search truncates, sheets/`max-w-[1400px]` grids verified at 390. |
| 10 | Console errors / failed requests / a11y | **0 JavaScript errors** in both capture runs (`consoleErrors: 0` in `final2-_evidence.json` and `final3-_evidence.json`). The final3 sweep logged **372 network entries, all *intended* honest states**: `299 × net::ERR_ABORTED` — TanStack Query cancellation, since every `queryFn` threads `signal` (`api/hooks.ts`) and `api/client.ts:67` re-throws aborts as control flow ("cancellation is control flow, not failure") so they never surface as an error state; `72 × /readyz → 503` (degraded relay — the body is a valid 503 and the UI says "degraded", never "healthy"; 56 in the earlier run, the count just tracks how many frames polled it); `1 × /v1/workflows → 401` (before a key is presented — the banner and `ErrorState` say "present an API key"). |
| 11 | Obsolete system confirmed removed | `grep -rn "fx-" web/src` → prose comments only; **7 of the 8** baseline stylesheets deleted (3,354 lines) and the icon module deleted — `graph/graph.css` deliberately remains as the re-tokened React Flow override; superseded deps removed from `package.json` and lockfile. |
| 12 | Final diff reviewed | Committed diff vs baseline `bbaffe4..HEAD`: **68 files, +7,632 / −6,259**, and `git diff --ignore-cr-at-eol` shows identical numbers → **no line-ending churn**. The a11y pass (12 files, +94/−57) and the one-line typecheck repair were each read hunk-by-hunk before landing. |

---

## 11. Genuine blockers and remaining work

1. **DLQ write verbs were never exercised against the live engine.** The local queue is empty
   (`GET /v1/dlq` returns zero rows, an empty queue being the healthy state), so the browser
   sweep can only assert "no dead letters available to exercise the verb". The contract is
   covered by 5 unit tests (`screens/dlq.test.tsx`: preview sends `dry_run: true` and never a
   write; confirm requires a typed reason; reader keys see disabled verbs + the 403 notice;
   Open/All toggles the query). **What is needed to close it:** seed a workflow into
   `FAILED_MANUAL` (retry-exhausting a step against a failing compensator) and re-run the
   sweep. Not done here because it mutates durable engine state.
2. **Rate limiting is hardcoded, so the 429 path is unobservable.**
   `internal/api/api.go:87` sets `const defaultRateLimit = 100` req/min per key label with no
   configuration seam; the cockpit renders `RateLimitError` + `Retry-After` faithfully but the
   429 state was not reached from the browser. **Needed:** a server flag/env for the limit, or a
   test harness that drives >100 req/min. This is a backend change and was out of Phase 7 scope.
3. **No formatter exists** (gate 1). Adding Prettier/dprint is a repo-wide decision with a
   large whitespace diff; Phase 7 deliberately did not make it.
4. **TanStack Table uses the v9 `legacy` React entry** (§8) — migration to the modern wrapper is
   open, plus 15 `react-refresh` warnings that a component/hook file split would clear.
5. **Bundle size**: single 1.43 MB entry chunk. Route-level code splitting (inspector graph,
   charts) is worth doing, but changing chunking mid-verification would invalidate the captured
   evidence, so it is left as the next step.
6. **OFL text is not vendored next to the built fonts.** Geist/Geist Mono are bundled from
   `@fontsource-variable/*` (which ship the licence in-package); if `web/dist` is ever
   distributed standalone, the OFL file should be copied into the bundle (e.g.
   `web/public/licenses/`) and referenced from `docs/ATTRIBUTION_AND_LICENSES.md`.
7. **Storybook / Figma / Context7 / Penpot never entered the pipeline** (§2). Nothing is
   claimed as verified by them; component verification came from Vitest + real-browser QA.

---

## 12. Git safety and final state

History preserved; no remote touched. **No push, deploy, publish, DNS, hosting or secret
change was performed** — none of those commands ran. `install_extension` was never called; no
purchase, account or credential was created. Nothing secret and no capture is committed
(`.artifacts/` is ignored; screenshots and harnesses stay local).

Phase commits on `main`, oldest first:

| Commit | Contents |
| --- | --- |
| `4358b97` | M1–M2 foundation: Tailwind v4 + shadcn/ui (24 components), Glacier Glass token architecture, Geist typography, lucide/recharts/tanstack installed |
| `3af60d7` | M3 shared kit, shell, command palette |
| `9fd1cec` | retire the legacy `fx-*` global stylesheet layer |
| `1e68658` | M4 Overview, Workflows, Metrics on Recharts + TanStack Table |
| `799f37a` | M5 execution inspector (React Flow), DLQ, Events |
| `151dff8` | M6 Settings, create-workflow dialog, 404 |
| `b083500` | M7 delete the retired `fx-*` design system and dead dependencies |
| `ca6c8c0` | **M8 measured a11y pass + removal of the last legacy hooks + DLQ unit tests** |
| `6f0a2f7` | **M8 typecheck gate repaired** — `npm run typecheck` no longer emits compiled `.js` into `web/src` (§10 gate 3) |
| `c549af3` | **this report** — `docs/PHASE_7_DESIGN_SYSTEM_REPLACEMENT_REPORT.md` |

Baseline: `bbaffe4` (Phase 6.7). Committed delta across the nine code commits above
(`git diff --shortstat bbaffe4..6f0a2f7`): 68 files, +7,632 / −6,259. This report adds one file.

### Evidence locations (local, git-ignored)

| Artifact | Path |
| --- | --- |
| Before screenshots (Phase 6.7, 8 routes × 5 viewports) | `.artifacts/p67/audit-*.png` |
| After screenshots (11 routes × 5 viewports + folds) — **authoritative** | `.artifacts/p7/final3/p7final3-*.png` + `p7final3-_evidence.json` |
| After screenshots, pre-cleanup run (superseded, corroborating) | `.artifacts/p7/final2/p7final2-*.png` + `p7final2-_evidence.json` |
| Re-validation after gate 3 (32/32 checks) | `.artifacts/p7/interact7-recheck.log` |
| Re-validation contrast audit (16 runs, 1,406 nodes, 0 offenders) | `.artifacts/p7/contrast7-recheck.log` |
| Screenshot + console/network capture driver (`node cap7.mjs <outDir> <label>`) | `.artifacts/cap7.mjs` |
| Interaction + a11y sweep driver (32 checks) | `.artifacts/interact7.mjs` |
| Contrast-only multi-route driver | `.artifacts/contrast7.mjs` |
| WCAG solvers used to pick token values | `.artifacts/wcag.mjs`, `.artifacts/wcag2.mjs` |
| Background-composite probe (defect root-cause) | `.artifacts/probe-bg.mjs` |
