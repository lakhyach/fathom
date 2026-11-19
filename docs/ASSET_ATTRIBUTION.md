# Asset attribution

This document records the visual assets and libraries shipped by the Fathom cockpit. Project-owned artwork is original SVG/React code; third-party libraries remain under the licences recorded in their package metadata and upstream notices.

## Brand identity

The visible product name is **Fathom**. Its original mark is a luminous depth pin above three contour lines, drawn inline in `web/src/components/brand.tsx` and in `web/public/fathom.svg` for the browser tab. Both use the same geometry and green palette. There are no remote logo or image requests.

## Typography

| Family | Use | Package | Licence |
| --- | --- | --- | --- |
| Outfit Variable | Cockpit interface and display text | `@fontsource-variable/outfit` | SIL Open Font License 1.1 |
| Geist Mono Variable | IDs, timestamps, and tabular data | `@fontsource-variable/geist-mono` | SIL Open Font License 1.1 |

Both font families are bundled into the frontend build through `web/src/main.tsx`; runtime font requests do not leave the app origin. Font licences ship with their packages in `web/node_modules` and the npm lockfile pins the resolved package versions.

## Iconography and UI libraries

- [Lucide](https://lucide.dev), delivered by `lucide-react` (ISC), supplies interface symbols.
- Radix UI primitives, shadcn-style components, Tailwind CSS, and Motion build the cockpit controls and layout. Their package licences are retained in the npm dependency graph.
- Recharts supplies the dashboard charts; React Flow supplies workflow execution diagrams. The React Flow attribution badge remains visible as required by its licence tier.

## Provenance

Fathom's logo and decorative KPI artwork are project-owned original work. The interface uses no hotlinked photography, externally hosted fonts, or third-party image assets. Product and implementation provenance is documented in [`ATTRIBUTION_AND_LICENSES.md`](ATTRIBUTION_AND_LICENSES.md).
