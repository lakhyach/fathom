# Data & API Contracts — normative

PostgreSQL 17, single database for the control plane. All DDL below is the **contract** the Phase-3 migrations must realise (names, constraints, indexes are normative; types may gain extras). Timestamps `timestamptz` UTC everywhere. JSONB for payloads; relational columns for anything a guard or index touches — **state, versions, identity keys are never JSONB-only** (the audited repo's JSONB step-status map was the DS-1 substrate).

Transaction boundary rule (from state machine §6, restated because it is testable): *one tx = one state change + its outbox rows + its audit rows; no network I/O inside.*

---

## A. Relational model

### A.1 Definitions & instances

```sql
CREATE TABLE workflow_definition (
  name        TEXT NOT NULL,
  version     INT  NOT NULL,
  steps       JSONB NOT NULL,          -- ordered array per state-machine §1; validated by engine, not by schema
  status      TEXT NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);

CREATE TABLE workflow (
  id              UUID PRIMARY KEY,                -- app-generated (uuidv7: time-sortable)
  def_name        TEXT NOT NULL,
  def_version     INT  NOT NULL,
  def_snapshot    JSONB NOT NULL,                  -- pinned at creation; runtime never reads the live definition
  state           TEXT NOT NULL CHECK (state IN
                  ('QUEUED','RUNNING','RETRY_WAITING','COMPENSATING','CANCELLING',
                   'COMPLETED','FAILED','ABORTED','FAILED_MANUAL')),
  version         BIGINT NOT NULL DEFAULT 1,       -- optimistic lock; REQUIRED in every UPDATE predicate
  business_key    TEXT NOT NULL,                   -- e.g. 'room:42:2026-12-20/2026-12-24'
  input           JSONB NOT NULL,
  deadline_at     TIMESTAMPTZ NOT NULL,            -- REQ-C-5; reaper scans
  next_attempt_at TIMESTAMPTZ,                     -- durable retry schedule (RETRY_WAITING)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,  finished_at TIMESTAMPTZ,
  CONSTRAINT terminal_coherence CHECK (
    (state IN ('COMPLETED','FAILED','ABORTED')) = (finished_at IS NOT NULL))       -- terminal ⇔ finished
);
CREATE UNIQUE INDEX workflow_active_business_key
  ON workflow (business_key)
  WHERE state NOT IN ('COMPLETED','FAILED','ABORTED');        -- one active workflow per target (DS-8/DS-10-class)
CREATE INDEX workflow_reaper ON workflow (deadline_at)
  WHERE state IN ('QUEUED','RUNNING','RETRY_WAITING','COMPENSATING','CANCELLING');
CREATE INDEX workflow_list   ON workflow (created_at DESC, id);                      -- keyset pagination
```

Transition guard (all engine writes; `RowsAffected != 1` ⇒ conflict handling, never a silent overwrite — closes DS-4):

```sql
UPDATE workflow SET state=:to, version=version+1, …
 WHERE id=:id AND version=:expected_from
   AND NOT (state IN ('COMPLETED','FAILED','ABORTED'));        -- belt-and-braces terminal wall (REQ-C-1)
```

```sql
CREATE TABLE step (
  workflow_id   UUID NOT NULL REFERENCES workflow ON DELETE CASCADE,
  step_type     TEXT NOT NULL,                    -- 'reserve-room','charge-payment','send-confirmation'…
  position      INT  NOT NULL,                    -- declaration order
  state         TEXT NOT NULL CHECK (state IN
    ('PENDING','ISSUED','IN_PROGRESS','SUCCEEDED','FAILED','TIMED_OUT',
     'COMPENSATION_PENDING','COMPENSATING','COMPENSATED','COMPENSATION_FAILED')),
  active_attempt INT NOT NULL DEFAULT 0,          -- the fencing token (state machine §4.2)
  lease_holder  TEXT,  lease_expires_at TIMESTAMPTZ,
  response_deadline_at TIMESTAMPTZ,               -- per-step forward timeout
  compensation_deadline_at TIMESTAMPTZ,
  output        JSONB,
  version       BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (workflow_id, step_type)
);
CREATE INDEX step_claim ON step (response_deadline_at)
  WHERE state IN ('ISSUED','IN_PROGRESS');        -- reaper: overdue responses; lease loss
```

```sql
CREATE TABLE attempt (
  workflow_id UUID NOT NULL, step_type TEXT NOT NULL, number INT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN
    ('ISSUED','IN_PROGRESS','SUCCEEDED','FAILED','TIMED_OUT','LOST','ABANDONED')),
  error_class TEXT CHECK (error_class IN ('RETRYABLE','TERMINAL','UNKNOWN')),
  error_detail JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  PRIMARY KEY (workflow_id, step_type, number),
  FOREIGN KEY (workflow_id, step_type) REFERENCES step(workflow_id, step_type)
);
```

### A.2 Events: inbound, processed, outbox

```sql
CREATE TABLE inbound_event (                   -- every received envelope, stored BEFORE classification
  event_id    UUID PRIMARY KEY,
  workflow_id UUID,                             -- NULL if unparseable ⇒ DLQ class UNPARSEABLE_EVENT
  step_type   TEXT, attempt INT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw         JSONB NOT NULL,
  classification TEXT CHECK (classification IN
    ('DUPLICATE','TERMINAL_IGNORED','UNSOLICITED','STALE','APPLIED','UNPARSEABLE'))
);
CREATE INDEX inbound_by_workflow ON inbound_event (workflow_id, received_at);

CREATE TABLE processed_events (                -- dedup ledger (the audited eventlog, generalised)
  event_id    UUID PRIMARY KEY REFERENCES inbound_event(event_id),
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  workflow_id UUID NOT NULL
);

CREATE TABLE outbox (
  seq          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- global monotonic order; SSE resume base
  event_id     UUID NOT NULL UNIQUE,
  workflow_id  UUID NOT NULL,
  step_type    TEXT NOT NULL, attempt INT NOT NULL,
  event_type   TEXT NOT NULL,                   -- 'fathom.command.issued.v1' | 'fathom.step.result.v1' …
  topic        TEXT NOT NULL,                   -- resolved by relay (command/result/dlq)
  payload      JSONB NOT NULL,                  -- full envelope incl. traceparent, causation_id
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ                      -- relay marker (absent in Phase 1: DS-9)
);
CREATE INDEX outbox_unpublished ON outbox (seq) WHERE published_at IS NULL;

CREATE TABLE relay_checkpoint (
  relay_name TEXT PRIMARY KEY,                  -- 'pgoutbox-1', 'cdc-main' — independent cursors
  last_seq   BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### A.3 Idempotency, leases, retry schedule

- **API idempotency:** `api_idempotency(key TEXT PK, request_hash BYTEA NOT NULL, response_status INT, response_body JSONB, response_headers JSONB, created_at, expires_at)`. Same key + same hash ⇒ replay stored response **with header `Idempotency-Replayed: true`**; same key + different hash ⇒ `422 IDEMPOTENCY_CONFLICT`.
- **Participant inbox (worker DBs, same pattern each):** `command_inbox(workflow_id UUID, step_type TEXT, attempt INT, event_id UUID, result JSONB, processed_at, PRIMARY KEY (workflow_id, step_type, attempt))` — written inside the side-effect tx; redelivery replays `result` and re-publishes without re-executing (state machine §4.4).
- **Retry schedule** is the pair `workflow.next_attempt_at` + `workflow.state='RETRY_WAITING'` (durable; survives restart; scanned by the reaper index). A separate table was rejected: one row per workflow keeps claim SQL to a single guarded UPDATE.
- **Leases** live on `step (lease_holder, lease_expires_at)`; heartbeat = guarded UPDATE extending expiry. Fencing = `attempt.number` (workers must echo it; participants reject lower).

### A.4 DLQ, audit, operator actions

```sql
CREATE TABLE dead_letter (
  id UUID PRIMARY KEY, workflow_id UUID NOT NULL, step_type TEXT, attempt INT,
  class TEXT NOT NULL CHECK (class IN
    ('RETRY_EXHAUSTED','COMPENSATION','DEADLINE','UNPARSEABLE_EVENT','LEASE_LOST')),
  reason_code TEXT NOT NULL, detail JSONB,
  raw_event_ref TEXT,                            -- pointer into inbound_event/outbox; envelope copied for export
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ, resolved_by TEXT, resolution TEXT
);
CREATE INDEX dead_letter_open ON dead_letter (created_at) WHERE resolved_at IS NULL;

CREATE TABLE audit_event (                       -- APPEND-ONLY. No UPDATE/DELETE grants. seq = SSE event id.
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_id UUID NOT NULL,
  kind        TEXT NOT NULL,                     -- 'TRANSITION','DECISION','EVENT_CLASSIFIED','OPERATOR_ACTION','REPLAY','DEADLETTER'
  from_state  TEXT, to_state TEXT,
  reason_code TEXT NOT NULL,                     -- machine-readable; UI REQ-OP-3 renders this
  detail      JSONB NOT NULL,                    -- incl. actor, event_id refs, pre-state snapshots for operator actions
  trace_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_by_workflow ON audit_event (workflow_id, seq);

CREATE TABLE operator_action (                   -- the authorization/audit record for W17/W18/replay
  id UUID PRIMARY KEY, workflow_id UUID NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('cancel','retry-now','force-terminate','complete-compensation','replay')),
  reason TEXT NOT NULL CHECK (length(reason) >= 8),
  dry_run BOOL NOT NULL, pre_snapshot JSONB NOT NULL, result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Grant policy (contract, verified by test):** application role has `SELECT,INSERT,UPDATE` on operational tables but **only `SELECT,INSERT` on `audit_event` and `processed_events`**; a dedicated `fathom_retention` role owns pruning. Test `AT-10` attempts UPDATE/DELETE on `audit_event` as the app role and asserts failure.

---

## B. REST API v1

Base `/v1`. AuthN: `Authorization: Bearer <api-key>` (roles `reader|operator|admin`); cockpit uses session cookie + CSRF token header. Error body = RFC 9457 `application/problem+json` with mandatory `code` (stable machine string) and `trace_id`:

```json
{ "type":"https://fathom.dev/errors/validation", "title":"Validation failed", "status":422,
  "code":"VALIDATION_FAILED", "detail":"…", "trace_id":"00-…", "instance":"/v1/workflows",
  "errors":[{"field":"input.checkout.date_range","rule":"required"}] }
```

| Method & path | Role | Semantics | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /v1/workflows` | operator/admin | create+start; headers `Idempotency-Key` (required, ≤255 chars), `If-Match` unused | `201` + body (workflow summary) + `Location: /v1/workflows/{id}` | `400` bad body; `409 ACTIVE_WORKFLOW_FOR_KEY` (business-key unique violated, body includes conflicting id); `422 VALIDATION_FAILED / IDEMPOTENCY_CONFLICT` |
| `GET /v1/workflows` | reader | list; filters `state,def_name,since,until,business_key~`; keyset pagination `limit≤100 (default 25), cursor`; sort `created_at_desc` only in v1 | `200` `{items[], next_cursor}` | `400 INVALID_CURSOR` |
| `GET /v1/workflows/{id}` | reader | full detail: workflow + steps + attempts + timings + version | `200` | `404 WORKFLOW_NOT_FOUND` (never 404-for-server-fault — DS-13 fix: `500` is `500`) |
| `GET /v1/workflows/{id}/events` | reader | audit history, cursor = `audit_event.seq` | `200` | `404` |
| `GET /v1/workflows/{id}/inbound` | reader | raw inbound event log with classification (the DS-1 visibility window) | `200` | `404` |
| `POST /v1/workflows/{id}/actions:cancel` | operator | W14/W14b; body `{reason}` | `202` | `409 NOT_CANCELLABLE` (terminal or COMPENSATING) |
| `POST /v1/workflows/{id}/steps/{t}/actions:abandon` | operator | give up active attempt → retry/compensate per table | `202` | `404/409` |
| `GET /v1/dlq` | reader | open DLQ items, filters `class,workflow_id` | `200` | — |
| `POST /v1/dlq/{id}/actions:resolve` | operator/admin | `{action: force-terminate|complete-compensation|retry-now, reason, dry_run?}`; dry-run returns computed effect without writing | `200` (result incl. audit seq) | `403 FORBIDDEN_ROLE`; `409 ALREADY_RESOLVED`; `422 REASON_REQUIRED` |
| `GET /v1/definitions` / `POST /v1/definitions` | reader / admin | list; register new version (validated: unique step types, declared compensators) | `200` / `201` | `422` |
| `GET /v1/stream` | reader | SSE — contract §C | `200` text/event-stream | `401/403` |
| `GET /healthz`,`/readyz`,`/metrics` | infra | liveness / DB+relay-lag readiness / Prometheus | `200` | `readyz` `503` with cause |

Every response carries `X-Request-Id` (uuidv7) echoed into logs. Rate limit: 100 req/min/key (`429` + `Retry-After`) — cheap, real, demonstrates care without pretending to be a gateway.

**Status-code discipline (DS-13 anti-regression, tested):** `404` only for genuinely missing resources; storage faults are `500` + `INTERNAL` problem body; concurrency losses are `409 CONFLICT_RETRY` with current `version` in the body.

## C. SSE contract (`GET /v1/stream`)

- Events: `workflow.transitioned`, `step.transitioned`, `decision.recorded`, `deadletter.inserted`, `heartbeat` (comment line every 15 s to defeat proxy idle cuts).
- `id:` field = `audit_event.seq` (monotonic BIGINT — the resume cursor); `data:` = compact JSON `{kind, workflow_id, from_state?, to_state?, reason_code, created_at, trace_id}`.
- **Reconnection:** client sends `Last-Event-ID: <seq>`; server replays `audit_event WHERE seq > :last ORDER BY seq LIMIT 1000` then goes live (single query + LISTEN/NOTIFY `fathom_audit` for wakeups). Gap > retention horizon ⇒ server emits `resync_required` event; client refetches snapshot via REST. **No silent loss, no duplicates that matter** (clients key state by `seq`).
- Fan-out cap per token (10) ⇒ `429` — protects the demo stack.
- `Retry: 2000` field sent on open.

## D. Idempotency matrix (normative; each row is a test)

| Layer | Key | Store | On duplicate | On key-reuse-with-different-content |
| --- | --- | --- | --- | --- |
| API create | `Idempotency-Key` | `api_idempotency` | replay stored response + `Idempotency-Replayed` header | `422 IDEMPOTENCY_CONFLICT` |
| Workflow target | `business_key` | partial unique index | `409 ACTIVE_WORKFLOW_FOR_KEY` | n/a |
| Command → participant | `(workflow_id, step_type, attempt)` | `command_inbox` | replay stored `result`, no re-effect | attempt mismatch ⇒ `STALE_ATTEMPT` refuse |
| Result → engine | `event_id` | `processed_events` | classification `DUPLICATE`, zero state effect | n/a |
| Operator replay | `operator_action.id` | `operator_action` + guarded transitions | each replay is a *new attempt* under version guard | raw re-emit is not an available action |

## E. Event envelope (wire format, `specversion: "1.0"`)

```json
{ "specversion":"1.0", "id":"<event uuidv7>", "source":"fathom.engine|fathom.worker.booking|…",
  "type":"fathom.step.result.v1 | fathom.command.issued.v1 | fathom.deadletter.v1",
  "time":"2026-10-23T10:00:00Z", "subject":"<workflow_id>",
  "workflow_id":"…", "step_type":"reserve-room", "attempt":2,
  "causation_id":"<event that caused this one>", "traceparent":"00-<32hex>-<16hex>-01",
  "datacontenttype":"application/json",
  "data": { "outcome":"SUCCEEDED|FAILED", "error_class":"RETRYABLE|TERMINAL|null",
             "output":{…}, "details":{…} } }
```

Rules: `subject` doubles as the Kafka partition key (per-workflow ordering); participants **must** echo `step_type`+`attempt` from the command they answer (identity, not vibes — the DS-1/DS-6 hole was an event that didn't say which step it belonged to); `FAILED` requires `error_class` (engine retries only `RETRYABLE`; `UNKNOWN` = one retry then terminal, never infinite).

## F. Participants' own schemas (showcase domain)

**Booking (worker DB):** `room(id, name)`; `room_stay(room_id, stay daterange, workflow_id, status, PRIMARY KEY(room_id, stay) via EXCLUDE USING gist (room_id WITH =, stay WITH &&) WHERE (status='HELD'))` — overlap impossible at constraint level (fixes DS-5's boolean flag and the never-read `start_date/end_date`). `booking_inbox` = §A.3. Compensator `release-room` flips `status→RELEASED` (append, not delete; audit-friendly) and is idempotent per attempt.

**Payment (worker DB):** append-only ledger `payment_entry(payment_id UUID, workflow_id, attempt, kind CHECK IN ('AUTHORIZATION','CAPTURE','VOID','REFUND'), amount_cents, currency, card_token, card_last4, created_at, PRIMARY KEY(payment_id, kind, attempt))` — a replayed refund is a new attempt row, visible, never a PK collision (fixes DS-7). Step succeeds only on `CAPTURED` result event (fixes `REQUESTED`-as-success). `card_token` opaque; **no PAN stored** (Phase 1 stored `credit_card_no VARCHAR(16)`).

**Demo gateway simulator:** deterministic rules (last-4 `9999` ⇒ `RETRYABLE` decline; `0000` ⇒ hang past deadline; `5555` ⇒ capture fails after authorize), failure-injectable via env — replaces the audited `strings.HasSuffix` status derivation with something that *tests the engine* instead of faking money.
