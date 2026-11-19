# Phase 8.2 — Local Readiness and End-to-End Validation

**Date:** 2026-11-19 · **Branch:** `main` · **Scope:** finish the in-progress
cockpit art work, split route loading, repair local secret scanning, and verify
the real browser-to-API workflow.

## Changes completed

- Connected the five existing decorative KPI artworks to the Overview cards.
  They are hidden from assistive technology and sit behind the existing
  data-driven visuals; they do not encode metric values.
- Changed the app screens to lazy imports with an accessible loading
  state. The first built JavaScript chunk fell from 1,505.97 KB to 717.15 KB;
  the build still reports that shared chunk above Vite's 500 KB advisory.
- Expanded the repository hygiene scan to cover first-party TS/TSX/JS/JSX,
  while excluding ignored local artifacts, dependencies, docs, and test
  fixtures. This prevents third-party sample keys and certificates in the local
  Go module cache from failing the check.
- Added frontend typecheck, unit-test, lint, and production-build steps to the
  GitHub Actions CI workflow.
- Corrected startup instructions: the program reads environment variables and
  does not load `.env`; `.env.example` now states that directly and includes a
  fake admin key for local definition registration.

## Local verification

| Check | Result |
| --- | --- |
| `go test ./...` | Passed, including secret-hygiene checks |
| `go vet ./...` | Passed |
| `go build ./...` | Passed |
| `npm test` | Passed: 10 files, 65 tests |
| `npm run lint` | Passed with 15 existing Fast Refresh warnings; no errors |
| `npm run build` | Passed; route chunks emitted; 717.15 KB shared-chunk advisory remains |
| API `GET /healthz`, `GET /readyz` through Vite proxy | Both returned HTTP 200; readiness reported `ready` |
| Browser workflow | Registered a one-step `echo` definition in the UI, created a workflow, and observed the worker complete it successfully in PostgreSQL |
| Browser routes | Overview, Workflows, Dead Letter, Events & Audit, Metrics & Health, Settings, workflow detail, and the unmatched-route screen rendered |
| Browser console | No errors or warnings observed |

The browser verification used a dedicated local PostgreSQL database and a fake
local admin key. The `echo` participant is the documented wiring sample; it
does not stand in for a business participant. The browser remains open at the
local Overview for review.

## Hosting gate

The application is working end to end locally. It is **not ready for public
deployment** under the current security contract: the Go API rejects non-loopback
binds, the cockpit reaches it through the Vite development proxy, and browser
bearer keys are a local-development boundary. A Vercel frontend deployment by
itself would not reach this API or execute workers. Public hosting requires an
approved persistent API/database target plus a production authentication and
network design, as listed in `THREAT_MODEL.md` §5. No deployment was made.

The optional Kafka/Debezium CDC smoke was not run because Docker Desktop is not
running. The local PostgreSQL workflow path and the existing Go/frontend test
suites were run.
