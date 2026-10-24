# Attribution & Licenses

Provenance record for Fathom. Every license statement below was **verified by reading the license file in the resolved module cache / package registry on 2026-10-23** (🔬), not by recalling upstream READMEs.

## 1. Inspiration provenance — the audited repository

- **Project:** `semotpan/saga-orchestration-go` @ commit `82a3af1` — https://github.com/semotpan/saga-orchestration-go
- **License:** MIT, `Copyright (c) 2023 Serghei Motpan` 🔬 (read from `LICENSE`, 21 lines)
- **Our license:** MIT, `Copyright (c) 2026 Lakhyajit Changmai`, with an attribution paragraph naming the upstream (recorded in `LICENSE`) — satisfies the MIT notice-retention obligation *and* the portfolio-honesty obligation.

### Reuse ledger (normative — update this table before any code from elsewhere lands)

| Component in Fathom | Relation to upstream | Verbatim code? |
| --- | --- | --- |
| In-transaction outbox (state change + outbox row, one tx) | **concept re-implemented** from upstream (its strongest verified pattern, Phase 1 audit row 1) | **No** — different schema (`seq` identity, `published_at`, checkpoints), different code |
| Consumer dedup recorded inside the consuming transaction (`processed_events`, `command_inbox`) | **concept re-implemented** from upstream `eventlog` (audit row 6), generalised to `(workflow, step, attempt)` + `event_id` | No |
| Debezium Outbox EventRouter CDC topology (aggregate-type routing, `id` header as event identity) | **configuration pattern re-implemented** from upstream's verified-working connectors, modernised to Debezium 3.x | No |
| Saga status derivation from a value set; `room.available` boolean; single-row payment table; YAML-in-CWD config; `confluent-kafka-go` v1; `httprouter` 404-on-error; compose `sleep 20` | **discarded deliberately** (each maps to a Phase 1 defect ID) | No |
| Everything else (state machine, leases/fencing, reaper, DLQ, operator actions, SSE, cockpit, audit, tests, CI) | original to Fathom | No |

**Policy (ADR-016):** zero copied lines from upstream. If that ever changes, the copied file gets a header comment citing the source commit and this table gains a row — checked by the Phase-7 claims audit.

## 2. Go dependencies (probe-resolved versions; licenses read from module cache 🔬)

| Module | Version | License | Notes |
| --- | --- | --- | --- |
| `github.com/twmb/franz-go` | v1.22.2 | BSD-3-Clause 🔬 | Kafka client (ADR-005) |
| `github.com/twmb/franz-go/pkg/kadm` | v1.19.0 | BSD-3-Clause 🔬 | admin ops |
| `github.com/jackc/pgx/v5` | v5.11.0 | MIT 🔬 | Postgres driver/pool |
| `github.com/go-chi/chi/v5` | v5.5.0 | MIT 🔬 | HTTP router |
| `github.com/google/uuid` | v1.6.0 | BSD-3-Clause 🔬 | uuidv7 via option or stdlib-follow on: decide at M3.1 |
| `github.com/prometheus/client_golang` | v1.25.0 | Apache-2.0 🔬 — **ships a `NOTICE` file 🔬** | NOTICE must be reproduced per §4 |
| `go.opentelemetry.io/otel` (+ otlptracehttp, sdk) | v1.47.0 | Apache-2.0 🔬 | no NOTICE file in module 🔬 |
| `github.com/testcontainers/testcontainers-go` (+ /modules/postgres) | v0.44.0 | MIT 🔬 | test-only |
| transitives: `klauspost/compress` v1.20.3, `pierrec/lz4/v4` v4.1.33, `golang.org/x/*`, `google.golang.org/grpc` v1.83.2 | — | BSD-3 / Apache-2 🔬 | tracked in generated `licenses/` dump |

**Phase-5 status of this table:** the modules above were the probe-resolved set.
As of Phase 5 the **product module** (`go.mod`, verified) ships five direct
deps — `google/uuid`, `jackc/pgx/v5`, `golang-migrate/migrate/v4` (Phase 4) plus
`twmb/franz-go` **v1.22.2** (relay publisher) and `prometheus/client_golang`
**v1.25.0** (`/metrics`). `client_golang`'s **NOTICE obligation now attaches to
shipped binaries** (reproduction mechanism per §4; nothing is distributed yet —
no remote, no published images — so the obligation is staged, not live).
`kadm`, `chi`, `otel`, `testcontainers` remain tools/test-only, as listed.

**Licensing allowlist (CI-enforced at M3.1):** MIT, BSD-2/3-Clause, Apache-2.0, ISC, MPL-2.0. Anything else (GPL/AGPL/unlicensed) fails the build — this is the cheap wall that keeps the portfolio claim safe.
`confluent-kafka-go/v2` is *not* a dependency (ADR-005 decision); it remains in `tools/depprobe` history only as probe evidence, so its Apache-2.0/librdkafka obligations do not attach to shipped binaries.

## 3. Frontend dependencies (npm registry metadata, re-read 2026-10-24 for Phase 7 🔬)

Licences below were taken from `npm view <pkg> license` against the installed
tree, not from memory.

| Package | Version pinned | License |
| --- | --- | --- |
| `react`, `react-dom` | 19.3.1 | MIT |
| `vite` | 8.3.5 | MIT |
| `typescript` | as scaffolded by Vite template (TS 7.0.2 is newly released; adopt only after compatibility check — ADR-014) | Apache-2.0 |
| `@tanstack/react-query` | 5.104.5 | MIT |
| `@xyflow/react` | 12.12.0 | **MIT** 🔬 (core library is MIT; the separate "Pro" platform license applies only to pro-template assets, which we do not use — [xyflow open-source](https://xyflow.com/open-source)) |
| `tailwindcss` + `@tailwindcss/vite` | ^4.3.3 | MIT |
| `radix-ui` | ^1.8.1 | MIT |
| `shadcn/ui` component sources | vendored into `web/src/components/ui/*` | MIT |
| `class-variance-authority` | ^0.7.1 | **Apache-2.0** 🔬 — package ships `LICENSE` only, **no `NOTICE` file** |
| `clsx` | ^2.1.1 | MIT |
| `tailwind-merge` | ^3.7.0 | MIT |
| `tw-animate-css` | ^1.4.0 | MIT |
| `cmdk` | ^1.1.1 | MIT |
| `sonner` | ^2.0.8 | MIT |
| `motion` | ^14.6.0 | MIT |
| `lucide-react` | ^1.61.0 | ISC |
| `recharts` | ^3.10.1 | MIT |
| `@tanstack/react-table` | ^9.3.1 | MIT |
| `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` | ^5.3.0 | OFL-1.1 🔬 (the typeface itself; self-hosted, no runtime fetch — see `ASSET_ATTRIBUTION.md` §1) |

**Removed in Phase 7** (no remaining importer, so dropped rather than left
installed): `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`,
`@fontsource-variable/space-grotesk` (all OFL-1.1), `next-themes` (MIT), and
`cn` (an unrelated npm package that was never imported — the app's `cn()` helper
is local at `@/lib/utils`).

**React Flow attribution — licence posture corrected in Phase 7.** `@xyflow/react`
is MIT, but hiding the on-canvas "React Flow" badge is gated behind a **React Flow
Pro** subscription, which this project does not hold. Phase 6 documented
`proOptions={{ hideAttribution: true }}` as a supported, licence-clean option; it
is not. The option and the matching `display:none` CSS were removed, the badge
renders, and it is re-tokened into the surface instead.

**Apache-2.0 obligation (open).** `class-variance-authority` is Apache-2.0 with no
NOTICE file, so the requirement is to ship its license text with the distributed
work. §4's `THIRD_PARTY_NOTICES/` CI mechanism currently covers the **Go** binary
only; the web bundle's third-party notices are not yet generated. Tracked as
remaining work in `PHASE_7_DESIGN_SYSTEM_REPLACEMENT_REPORT.md` — not claimed as
done here.


## 4. Apache-2.0 obligations handling

Rule: any Apache-2.0 dependency **that ships a NOTICE** requires its NOTICE text reproduced in distributed artifacts. Verified status 🔬: `prometheus/client_golang` → NOTICE present; `otel` → none; `grpc` → none. Mechanism: `THIRD_PARTY_NOTICES/` directory generated in CI (`go-licenses` export + NOTICE concatenation), included in container images. No upstream Debezium/confluent code is linked into our binaries; Debezium/Kafka run as **separate containerized services** (no derivative-work question), images Apache-2.0 licensed and pulled unmodified.

## 5. Infrastructure images (CDC mode, Phase 4)

| Image | Purpose | License | Pinning rule |
| --- | --- | --- | --- |
| `quay.io/debezium/connect` 3.7.0.Final | CDC relay | Apache-2.0 | tag + digest; images only on quay.io since 3.0 ([notice](https://debezium.io/blog/2024-09-18/quay-io-reminder/)) |
| `apache/kafka` (KRaft) | broker | Apache-2.0 | tag + digest; official image per Kafka docs ([docker](https://kafka.apache.org/41/getting-started/docker/)) |
| `postgres` 17 | durable state | PostgreSQL License | tag + digest |
| `jaegertracing/all-in-one`, `prom/prometheus` | observability | Apache-2.0 / Apache-2.0 | tag + digest |

No `latest*` tags anywhere (Phase 1 DS-12 lesson); digests recorded in the compose files at Phase 3/4 and re-checked at every dependency-bump PR.

## 6. Trademark note

"Fathom" is an **internal codename only** (ADR-002): conflicts exist in unrelated product categories (AI notetakers, accounting BI). Public release under this name requires a fresh naming check and likely a rename — that decision belongs to Phase 7, not here.
