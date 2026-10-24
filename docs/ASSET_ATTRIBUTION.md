# Asset Attribution — Nunatak cockpit

Every non-code visual asset shipped in the cockpit, its origin, licence, and how
it is loaded. Reviewed 2026-10-24 against the Phase 7 working tree (design system
**Glacier Glass**). Sections marked *changed in Phase 7* describe what the
replacement removed; the Phase 6.x reports remain the historical record.

Design rule followed throughout: **no runtime external dependency**. Fonts and
artwork are bundled into the build and served from the same origin. No
third-party photography is hotlinked or downloaded.

---

## 1. Typography (self-hosted, SIL Open Font License 1.1) — *changed in Phase 7*

Both families are bundled at build time through Fontsource's variable packages.
They are emitted into `web/dist/assets/*.woff2` and referenced by the app's own
stylesheet — there is no `<link>` to Google Fonts or any other remote foundry,
and no network request for a font at runtime.

| Family | Role | Package (pinned) | Licence | Redistribution |
| --- | --- | --- | --- | --- |
| Geist Variable | UI / body / display text | `@fontsource-variable/geist@^5.3.0` | SIL OFL 1.1 | Permitted (bundled) |
| Geist Mono Variable | Numerals, IDs, code, timestamps | `@fontsource-variable/geist-mono@^5.3.0` | SIL OFL 1.1 | Permitted (bundled) |

The OFL permits bundling and redistribution in a compiled work provided the
fonts are not sold on their own and the licence is retained; Fontsource ships the
licence alongside each package.

Import site: `web/src/main.tsx` (`@fontsource-variable/geist`,
`@fontsource-variable/geist-mono`). Token bindings: `web/src/index.css`
(`--font-sans`, `--font-mono` inside Tailwind v4 `@theme inline`), consumed as the
`font-sans` / `font-mono` utilities.

**Retired in Phase 7:** Inter, JetBrains Mono and Space Grotesk (the Phase 6.x
type stack). They had no remaining importer once the `fx-*` layer was deleted, so
the three `@fontsource-variable/*` packages were removed from `package.json`
rather than left as dead weight.

## 2. Bespoke vector artwork (original — authored for this project)

### `web/public/nunatak.svg` — favicon / app icon
- **Origin:** original, hand-authored (Phase 6.1, refined in Phase 6.2).
- **Design:** an orchestration glyph — a diamond whose four summit/base/left/right
  vertices are nodes, linked by edges to a distinct hollow central **core** node.
  `viewBox="0 0 32 32"`; renders crisply at 16/32/48 px.
- **Licence:** project-owned; no third-party source.
- **Load:** `/nunatak.svg` referenced from `web/index.html` (favicon, same-origin,
  no network hop). The in-app brand mark (`NunatakMark`, `web/src/components/brand.tsx`)
  is inline SVG on the same geometry, drawn with currentColor so it follows tokens.
- **Phase 7 note:** the accent ramp on the favicon is the old blue→violet. It is
  kept deliberately — it is the product's identity mark, not part of the retired
  surface system, and re-cutting it would be a rebrand the brief did not ask for.

### `web/public/alpine.svg` — **removed in Phase 7**
The Phase 6 sidebar backdrop (an original 240×520 layered vector night range) was
deleted with `web/src/shell/shell.css`, the only file that referenced it as a
`background-image`. Glacier Glass builds the rail from token-driven surfaces
(`@utility surface-veil`), so no artwork sits behind the navigation and label
contrast no longer depends on a scrim over an image. The asset had zero remaining
importers; the licence question is therefore moot, and the file is gone rather
than orphaned in `public/`.

## 3. Iconography — *changed in Phase 7*
- **Origin:** [Lucide](https://lucide.dev) (`lucide-react@^1.61.0`), ISC licence —
  an open-source icon set of ~1.5k SVG components on a 24 px grid, 2 px stroke,
  round caps. Ships as inline `<svg>` React components.
- **Use:** every glyph in the cockpit (nav, status affordances, buttons, empty and
  error states, the command palette, graph nodes). Decorative instances are
  `aria-hidden="true"` and the surrounding control carries the accessible name.
- **Sizing/colour** is set with Tailwind utilities (`size-*`, `text-*`), so icons
  follow the same tokens as the rest of the system.
- **Retired in Phase 7:** the hand-drawn set in `web/src/icons/index.tsx`. Keeping
  two icon systems would have meant two stroke weights and two grids on screen at
  once; the custom set had no licence or attribution obligation, so removal is a
  consistency decision, not a compliance one.
- The brand `NunatakMark` remains original inline SVG (§2) and is not part of
  either icon set.

## 4. Third-party runtime libraries (for completeness)
Code dependencies that shape the visual surface, listed for a full audit trail:

| Library | Pinned | Licence | Note |
| --- | --- | --- | --- |
| `@xyflow/react` (React Flow) | 12.12.0 | MIT | Execution graph: nodes, animated edges, Controls, MiniMap. |
| `recharts` | ^3.10.1 | MIT | Every chart on Overview and Metrics. |
| `@tanstack/react-table` | ^9.3.1 | MIT | Sorting/filtering/pagination of the workflows ledger. |
| `@tanstack/react-query` | 5.104.5 | MIT | Polling / caching. |
| `radix-ui` | ^1.8.1 | MIT | Primitives behind the shadcn/ui components (dialog, tabs, select, tooltip, sheet, toast…). |
| `shadcn/ui` components | vendored | MIT (Vercel) | Copied into `web/src/components/ui/*` — source in this repo, not a runtime dependency. |
| `class-variance-authority` | ^0.7.1 | Apache-2.0 | Component variants. |
| `clsx` / `tailwind-merge` | ^2.1.1 / ^3.7.0 | MIT | The `cn()` class merger at `@/lib/utils`. |
| `cmdk` | ^1.1.1 | MIT | Command palette. |
| `sonner` | ^2.0.8 | MIT | Toasts. |
| `motion` (Motion One / framer-motion lineage) | ^14.6.0 | MIT | Route and disclosure transitions under `MotionConfig reducedMotion="user"`. |
| `lucide-react` | ^1.61.0 | ISC | Icon set (§3). |
| `tailwindcss` + `@tailwindcss/vite` | ^4.3.3 | MIT | Token engine and utility layer. |
| `tw-animate-css` | ^1.4.0 | MIT | Keyframe utilities used by Radix open/close animations. |
| `react`, `react-dom` | 19.3.1 | MIT | UI runtime. |
| `react-router` | ^7.0.0 | MIT | Routing. |
| `vite` | 8.3.5 | MIT | Build tool. |

**React Flow attribution — corrected in Phase 7.** The Phase 6 note here claimed
hiding the on-canvas badge via `proOptions={{ hideAttribution: true }}` was a
supported, licence-clean choice. It is not: removing the attribution is a
**React Flow Pro** subscription feature, which this project does not hold. The
option and the matching `display:none` rule were removed, the badge is rendered,
and it is re-tokened into the system (`web/src/graph/graph.css`) so it reads as
part of the surface instead of fighting it. Console warnings about a hidden
attribution are gone.

## 5. Brand naming — what was renamed and what deliberately stayed
Phase 6.1 is a **presentation-layer** rebrand ("Fathom" → "Nunatak"). Renamed:
visible product name, page title, nav/brand text, the API client class, dev-facing
UI copy. Deliberately **unchanged** (kept as `fathom`) to avoid breaking real
identifiers, per brief §2:
- Go module path `github.com/Lakhyajit-96/fathom` and the `fathom` binary /
  `fathom control|worker|relay|all` modes (the sidebar's offline hint references
  `fathom control` because that is the literal command).
- Backend Prometheus metric names, which are prefixed `fathom_*`
  (e.g. `fathom_workflows_total`) — these are the real series the UI reads.
- The localStorage key `fathom.cockpit.settings.v1` — renaming it would silently
  discard a presented key/session already stored in users' browsers.
