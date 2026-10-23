# Asset Attribution — Phase 6.1 Visual Redesign

Every non-code visual asset shipped in the Nunatak cockpit, its origin, licence,
and how it is loaded. Reviewed 2026-10-23 against the working tree at baseline
commit `20a1e5c` (Phase 6).

Design rule followed throughout (§4/§5/§11 of the brief): **no runtime external
dependency**. Fonts and artwork are bundled into the build and served from the
same origin. No third-party photography is hotlinked or downloaded.

---

## 1. Typography (self-hosted, SIL Open Font License 1.1)

All three families are bundled at build time through Fontsource's variable
packages. They are emitted into `web/dist/assets/*.woff2` and referenced by the
app's own stylesheet — there is no `<link>` to Google Fonts or any other remote
foundry, and no network request for a font at runtime.

| Family | Role | Package (pinned) | Licence | Redistribution |
| --- | --- | --- | --- | --- |
| Inter Variable | UI / body text | `@fontsource-variable/inter@^5.2.0` | SIL OFL 1.1 | Permitted (bundled) |
| JetBrains Mono Variable | Numerals, IDs, code | `@fontsource-variable/jetbrains-mono@^5.2.0` | SIL OFL 1.1 | Permitted (bundled) |
| Space Grotesk Variable | Display / headings / wordmark | `@fontsource-variable/space-grotesk@^5.3.0` | SIL OFL 1.1 | Permitted (bundled) |

Space Grotesk is **new in Phase 6.1**; Inter and JetBrains Mono were already in
use from Phase 6. The OFL permits bundling and redistribution in a compiled
work provided the fonts are not sold on their own and the licence is retained;
Fontsource ships the licence alongside each package.

Import site: `web/src/main.tsx` (`@fontsource-variable/{inter,jetbrains-mono,space-grotesk}`).
Token bindings: `web/src/theme/tokens.css` (`--fx-font-display`, `--fx-font-ui`, `--fx-font-mono`).

## 2. Bespoke vector artwork (original — authored for this project)

Both marks were drawn from scratch as SVG in this repository. They contain no
traced, stock, emoji, or Unicode-glyph source; they are original geometric
vector shapes owned by the project.

### `web/public/nunatak.svg` — favicon / app icon
- **Origin:** original, hand-authored (Phase 6.1).
- **Design:** a "peak-as-graph" mark — a summit whose three ridge vertices are
  flow nodes — on a rounded midnight tile, stroked with the blue→violet accent
  ramp. Reads crisply at 16/32/48 px.
- **Licence:** project-owned; no third-party source.
- **Load:** `/nunatak.svg` (favicon + same-origin, no network hop).

### `web/public/alpine.svg` — sidebar artwork
- **Origin:** original, hand-authored layered SVG (Phase 6.1). **240×520.**
- **Design:** a night alpine scene built from pure vector primitives — a sky
  gradient, an aurora band, a handful of stars, three layered ridges (far /
  mid / near) with gradient rim-light and snow caps, and a valley-fog fade into
  the sidebar base colour so it dissolves into the chrome.
- **Licence:** project-owned; no third-party source.
- **Load:** referenced as a `background-image` on the nav rail
  (`web/src/shell/shell.css`), `bottom center / cover`, pinned to the rail base.
- **Documented deviation (§4):** the brief suggested searching for a high-quality
  abstract alpine *photograph*, inspecting its licence, downloading it into
  public assets, and optimising it. Two constraints made an original SVG the
  better honest choice: (a) the tooling here must not download binaries over the
  network (wget/curl), and (b) any third-party photo would carry an external
  licence/attribution chain that cannot be verified to the standard the rest of
  this file holds. A bespoke vector is fully owned, licence-clean, crisp at every
  DPR, and a few hundred bytes. It is atmospheric rather than photographic, which
  still satisfies the "dark enough for nav, blue-violet highlights, minimal
  silhouettes, fading into the sidebar" intent.
- **Accessibility / motion:** the artwork is purely decorative; it sits behind the
  nav column (readable contrast is guaranteed by the scrim gradient overlay in
  `shell.css`, not by the image). Any parallax is intentionally omitted, so
  nothing here needs a reduced-motion gate; the global
  `prefers-reduced-motion` rule in `tokens.css` already neutralises all durations.

## 3. Iconography
- **Origin:** original inline SVG components in `web/src/icons/index.tsx` —
  hand-drawn on a 24 px grid, 1.5 px stroke, round caps; the brand `NunatakMark`
  on a 32 px grid. No icon library (no Lucide/Feather/Heroicons) is imported.
- **Licence:** project-owned. Rendered as inline `<svg>` (aria-hidden by default;
  the surrounding control carries the accessible name).

## 4. Third-party runtime libraries (for completeness)
These are code dependencies that affect the visual surface, not "assets", listed
for a full audit trail:

| Library | Pinned | Licence | Note |
| --- | --- | --- | --- |
| `@xyflow/react` (React Flow) | 12.12.0 | MIT | The execution graph. |
| `@tanstack/react-query` | 5.104.5 | MIT | Polling / caching. |
| `react`, `react-dom` | 19.3.1 | MIT | UI runtime. |
| `react-router` | ^7.0.0 | MIT | Routing. |
| `vite` | 8.3.5 | MIT | Build tool (dev only). |

**React Flow attribution:** the graph uses the library's official
`proOptions={{ hideAttribution: true }}` supported option, also mirrored in CSS
(`.fx-graph .react-flow__attribution { display: none }`). React Flow is MIT;
hiding the on-canvas attribution badge is an explicit, supported feature of the
package and does not violate its licence.

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
