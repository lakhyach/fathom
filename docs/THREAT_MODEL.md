# Threat Model — Fathom (Phase 2)

Scope: local-first demo/portfolio system (control plane, workers, relays, Postgres, cockpit SPA, optional Kafka/Debezium). Deployment on public internet is *contemplated* for Phase 7 — this model states what must be true before that. Method: assets → boundaries → STRIDE per boundary, with mitigations mapped to the spec section that carries them, and residual risk stated. Honest classification: **[DESIGNED]** = mitigation specified (not yet implemented — nothing is implemented); **[PROCESS]** = handled by CI/repo discipline; **[ACCEPTED]** = explicitly out of scope with reasoning.

## 1. Assets (ranked)

| # | Asset | Why it matters |
| --- | --- | --- |
| A1 | **Engine state integrity** (`workflow/step/attempt` + `audit_event`) | The product's entire claim is "what the cockpit shows is what happened." Corrupting this falsifies the demo itself. Phase 1 proved this is attackable *by a legitimate-looking message* (DS-1). |
| A2 | Operator action authority (retry/terminate/replay) | Unsafe recovery is worse than no recovery — DS-1's human "fix" was the poison. |
| A3 | Participant business data (inventory holds, payment ledger) | Money/availability semantics. |
| A4 | Demo credentials / session tokens | Low intrinsic value, high embarrassment value; also the gate to A1–A3. |
| A5 | Repository reputation (secrets, license, attribution) | Portfolio product; a leaked secret or license lapse is a career-level self-inflicted wound. |

## 2. Trust boundaries

```
[B1] operator/browser ──HTTPS/cookie──► API (authn, RBAC, idempotency)
[B2] worker/service   ──bearer key───►  API
[B3] engine/relay     ──SQL role────►   Postgres        (grant wall around audit/processed tables)
[B4] relay            ──produce────►    Kafka (CDC mode)
[B5] Debezium         ──WAL repl.──►    (reads outbox only; DB superuser-ish ⇒ must be isolated)
[B6] worker          ──event envelope─► engine ingress  (THE adversarial-boundary: classification §5)
[B7] any process     ──env file────►   config           (secret injection)
```

## 3. STRIDE

| # | Cat | Boundary | Threat | Mitigation (where specified) | Status |
| --- | --- | --- | --- | --- | --- |
| T-01 | **S**poofing | B6 | Forged "result" event naming a real workflow/step/attempt (exactly Phase 1's replay attack) — attacker or buggy service re-authors applied events | Identity block on envelope (DATA §E: step+attempt required); classification wall (`TERMINAL_IGNORED/STALE`, SM §5); version-guarded updates; **and** the property-test invariant AT-12. In lite mode the transport is in-proc (smaller surface); in CDC mode Kafka ACLs apply (T-14) | [DESIGNED] — *this is the product's core security property* |
| T-02 | **T**ampering | B3 | Direct SQL edit of `audit_event`/`workflow` to fake history or revive a terminal state | Grant wall: no UPDATE/DELETE on `audit_event` for app role; terminal-state UPDATE guard (0 rows); `terminal_coherence` CHECK; AT-10 permission test | [DESIGNED] + [PROCESS] |
| T-03 | **T**ampering | B7/B1 | Outbox row inserted by a non-authoritative writer (the Phase-1 injection path: `INSERT INTO outboxevent` by hand) | In Fathom, publication goes through the relay reading *engine-owned* outbox only; worker DBs are separate roles; compose grants `INSERT` on outbox to engine role only. Residual: anyone with DB credentials can still insert — which is precisely why the Phase 1 lesson is defence-in-depth: no single wall (grants *or* classification) is trusted alone; state-vs-reality divergence must be impossible even when one layer is bypassed. | [DESIGNED] |
| T-04 | **R**epudiation | B1/B2 | Operator performs a destructive action, denies it | `operator_action` table with actor, role, reason ≥ 8 chars, pre-state snapshot; `audit_event` append-only; metric `fathom_operator_actions_total` | [DESIGNED] |
| T-05 | **I**nfo disclosure | B1 | Cockpit exposes other users' workflow data | Single-tenant demo **[ACCEPTED]**; still: role-scoped reads, no `/debug` exposure, error bodies carry no stack/SQL (problem+json `code` only) | [DESIGNED-partial] |
| T-06 | **I**nfo disclosure | repo | Secrets committed (Phase 1 pattern: tracked `password: secret` ×6 files) | RT-08 CI grep gate (fails build on `password:` in tracked files); `.gitignore` env rules [already in place]; env-only injection; pre-commit hook | [PROCESS] |
| T-07 | **I**nfo disclosure | A3 | Card data at rest — Phase 1 stored `credit_card_no VARCHAR(16)` | Contract forbids PAN: `card_token` + `last4` only (DATA §F); no external gateway in demo **[ACCEPTED as simulated]** | [DESIGNED] |
| T-08 | **D**os | B1 | API flood / retry storms; SSE stream hogging | Rate limit 100/min/key + `Retry-After`; SSE fan-out cap 10/token; body size caps; `deadline_at` bounds per-workflow resource use *by design* (an abandoned workflow cannot pin state forever — SM §8) | [DESIGNED] |
| T-09 | **D**os | B4/B6 | Poison-pill unparseable event stalls a consumer | Classify `UNPARSEABLE_EVENT` → DLQ, continue (RT-04 test makes this *verified behaviour*, vs Phase 1 where a PK collision silently stranded the saga — DS-7) | [DESIGNED] |
| T-10 | **E**levation | B1 | `reader` calling operator endpoints; replayed session | RBAC middleware at route level (API §B role column); cookie `Secure/HttpOnly/SameSite=Lax` + CSRF header; 403 audited | [DESIGNED] |
| T-11 | **E**levation | B3 | Compromised app role writes audit-protected tables | Role separation (`fathom_app` vs `fathom_retention` vs migrate role); grants tested (AT-10) | [DESIGNED] |
| T-12 | **E**levation | B5 | Debezium connector DB user over-reaching | Connector role: `REPLICATION` + `SELECT` on outbox only; `wal_level=logical` slot scoped; not the table-owning role | [DESIGNED] |
| T-13 | **R**epudiation/Integrity | A5 | License/attribution lapse (MIT notice dropped; Apache deps' NOTICE ignored) | `ATTRIBUTION_AND_LICENSES.md` + LICENSE attribution clause; dep-license allowlist in CI | [PROCESS] |
| T-14 | spoof/MITM | B4 (CDC, deployed) | Anyone reaching plaintext Kafka injects messages | Local demo: network-isolated compose **[ACCEPTED]**. **Deployment gate:** SASL/TLS mandatory (franz-go SCRAM supported, probe verified) before any public network exposure; TLS for Postgres (`sslmode=require`) | [DESIGNED-gated] |
| T-15 | **D**os | B3 | Outbox/audit table unbounded growth (DS-9) | `published_at` pruning + retention job; audit retained; `fathom_outbox_unpublished_count` alarm; bounded by the soak in Gate 3 | [DESIGNED] |

## 4. Non-goals stated plainly

Multi-tenant isolation, external attacker on a hosted deployment (until Phase 7 gate T-14), secrets-manager integration, supply-chain signing (SBOM/provenance is a Phase 7 nice-to-have), sidecar/service-mesh identity. Declining these is a scope decision, not an oversight — each is named so nobody later mistakes absence for completeness.

## 5. What deployment would additionally require (pre-authorisation checklist)

1. TLS termination + HSTS, secure cookies end-to-end (T-05/T-14 upgrade from [ACCEPTED]).
2. Kafka SASL/TLS + ACLs, or lite relay only (recommendation: **public demo runs the pgoutbox relay**; CDC mode stays local — it is a demonstration of architecture, not a hosting requirement).
3. Per-role credentials provisioned out-of-band; demo accounts clearly labelled.
4. Dependency scanning in CI (Trivy govulncheck) + secret-scan on every push.
5. Rate limiting at the edge, not just in-app.
6. Re-run this threat model against the *implemented* system and update statuses from [DESIGNED] to [VERIFIED-by-test-ID] — a mitigation without a test ID keeps its [DESIGNED] label, exactly like Phase 1's capability classes.
