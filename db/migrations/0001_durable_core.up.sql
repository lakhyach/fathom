-- Phase 4 — durable workflow engine core.
-- Realises docs/DATA_AND_API_CONTRACTS.md §A for the engine-control-plane tables.
-- Scope decisions (docs/PHASE_4_SPEC_CHECKLIST.md §3): workflow_definition is
-- represented by workflow.def_snapshot pinned at creation; relay_checkpoint and
-- command_inbox (participant-side) are not in this phase's storage contract.
-- dead_letter IS included (the machine emits EffectDeadLetter on W12; discarding
-- it would violate "never silently discard an error"), but DLQ *resolution*
-- (operator actions, W17/W18) is a later phase — only the durable insert here.
-- operator_action likewise defers to the operator phase. Names/constraints/
-- indexes below are normative per the contract; only additive columns appear.
-- Note: golang-migrate runs each file inside one transaction; no BEGIN/COMMIT here.

-- ---------------------------------------------------------------------------
-- A.1 Instances
-- ---------------------------------------------------------------------------

CREATE TABLE workflow (
  id              UUID PRIMARY KEY,                -- app-generated (uuidv7: time-sortable)
  def_name        TEXT NOT NULL,
  def_version     INT  NOT NULL,
  def_snapshot    JSONB NOT NULL,                  -- pinned at creation; runtime never reads a live definition
  state           TEXT NOT NULL CHECK (state IN
                  ('QUEUED','RUNNING','RETRY_WAITING','COMPENSATING','CANCELLING',
                   'COMPLETED','FAILED','ABORTED','FAILED_MANUAL')),
  version         BIGINT NOT NULL DEFAULT 1,       -- optimistic lock; REQUIRED in every UPDATE predicate
  business_key    TEXT NOT NULL,                   -- e.g. 'room:42:2026-12-20/2026-12-24'
  input           JSONB NOT NULL,
  deadline_at     TIMESTAMPTZ NOT NULL,            -- REQ-C-5; reaper scans
  next_attempt_at TIMESTAMPTZ,                     -- durable retry schedule (RETRY_WAITING)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  CONSTRAINT terminal_coherence CHECK (
    (state IN ('COMPLETED','FAILED','ABORTED')) = (finished_at IS NOT NULL))       -- terminal <=> finished
);

-- One active workflow per target (DS-8/DS-10 class).
CREATE UNIQUE INDEX workflow_active_business_key
  ON workflow (business_key)
  WHERE state NOT IN ('COMPLETED','FAILED','ABORTED');
CREATE INDEX workflow_reaper ON workflow (deadline_at)
  WHERE state IN ('QUEUED','RUNNING','RETRY_WAITING','COMPENSATING','CANCELLING');
CREATE INDEX workflow_list ON workflow (created_at DESC, id);                       -- keyset pagination

CREATE TABLE step (
  workflow_id   UUID NOT NULL REFERENCES workflow ON DELETE CASCADE,
  step_type     TEXT NOT NULL,
  position      INT  NOT NULL,                    -- declaration order
  state         TEXT NOT NULL CHECK (state IN
    ('PENDING','ISSUED','IN_PROGRESS','SUCCEEDED','FAILED','TIMED_OUT',
     'COMPENSATION_PENDING','COMPENSATING','COMPENSATED','COMPENSATION_FAILED')),
  active_attempt INT NOT NULL DEFAULT 0,          -- the fencing token (state machine §4.2)
  max_attempts  INT  NOT NULL CHECK (max_attempts >= 1),
  compensable   BOOL NOT NULL DEFAULT FALSE,      -- from def_snapshot at creation
  lease_holder  TEXT,
  lease_expires_at TIMESTAMPTZ,
  response_deadline_at TIMESTAMPTZ,               -- per-step forward timeout
  compensation_deadline_at TIMESTAMPTZ,
  output        JSONB,
  version       BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (workflow_id, step_type)
);
CREATE INDEX step_claim ON step (response_deadline_at)
  WHERE state IN ('ISSUED','IN_PROGRESS');        -- reaper: overdue responses; lease loss

CREATE TABLE attempt (
  workflow_id UUID NOT NULL,
  step_type   TEXT NOT NULL,
  number      INT  NOT NULL CHECK (number >= 1),
  state       TEXT NOT NULL CHECK (state IN
    ('ISSUED','IN_PROGRESS','SUCCEEDED','FAILED','TIMED_OUT','LOST','ABANDONED')),
  error_class TEXT CHECK (error_class IN ('RETRYABLE','TERMINAL','UNKNOWN')),
  error_detail JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (workflow_id, step_type, number),
  FOREIGN KEY (workflow_id, step_type) REFERENCES step(workflow_id, step_type)
);

-- ---------------------------------------------------------------------------
-- A.2 Events: inbound ledger, dedup, transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE inbound_event (                       -- every envelope, stored BEFORE classification
  event_id    UUID PRIMARY KEY,
  workflow_id UUID,                                -- NULL if unparseable => DLQ class UNPARSEABLE_EVENT
  step_type   TEXT,
  attempt     INT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw         JSONB NOT NULL,
  classification TEXT CHECK (classification IN
    ('DUPLICATE','TERMINAL_IGNORED','UNSOLICITED','STALE','APPLIED','UNPARSEABLE'))
);
CREATE INDEX inbound_by_workflow ON inbound_event (workflow_id, received_at);

CREATE TABLE processed_events (                     -- dedup ledger (the audited eventlog, generalised)
  event_id    UUID PRIMARY KEY REFERENCES inbound_event(event_id),
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  workflow_id UUID NOT NULL
);

CREATE TABLE outbox (
  seq          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- global monotonic order; SSE resume base
  event_id     UUID NOT NULL UNIQUE,
  workflow_id  UUID NOT NULL,
  aggregate_id TEXT NOT NULL,                      -- explicit event key for CDC/Debezium extraction (ADR-007)
  step_type    TEXT NOT NULL,
  attempt      INT  NOT NULL,
  event_type   TEXT NOT NULL,                      -- 'fathom.command.issued.v1' | 'fathom.step.result.v1' ...
  topic        TEXT NOT NULL,                      -- resolved by relay (command/result/dlq)
  payload      JSONB NOT NULL,                     -- full envelope incl. traceparent, causation_id
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ                         -- relay marker; NULL = pending
);
CREATE INDEX outbox_unpublished ON outbox (seq) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- A.3 API creation idempotency (durable across restarts)
-- ---------------------------------------------------------------------------

CREATE TABLE api_idempotency (
  key               TEXT PRIMARY KEY CHECK (char_length(key) <= 255),
  request_hash      BYTEA NOT NULL,                -- canonical fingerprint of the create request
  workflow_id       UUID,                          -- set once the create committed
  response_status   INT,
  response_body     JSONB,
  response_headers  JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------
-- A.4 Audit — append-only
-- ---------------------------------------------------------------------------

CREATE TABLE dead_letter (                         -- durable operator work items (SM §7).
  id            UUID PRIMARY KEY,
  workflow_id   UUID NOT NULL REFERENCES workflow ON DELETE CASCADE,
  step_type     TEXT,
  attempt       INT,
  class         TEXT NOT NULL CHECK (class IN
                  ('RETRY_EXHAUSTED','COMPENSATION','DEADLINE','UNPARSEABLE_EVENT','LEASE_LOST')),
  reason_code   TEXT NOT NULL,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_event_ref TEXT,                              -- pointer into inbound_event/outbox
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,                       -- resolution is a later phase
  resolved_by   TEXT,
  resolution    TEXT
);
CREATE INDEX dead_letter_open ON dead_letter (created_at) WHERE resolved_at IS NULL;

CREATE TABLE audit_event (                          -- APPEND-ONLY. seq = SSE event id.
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_id UUID NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN
    ('TRANSITION','DECISION','EVENT_CLASSIFIED','OPERATOR_ACTION','REPLAY','DEADLETTER')),
  from_state  TEXT,
  to_state    TEXT,
  reason_code TEXT NOT NULL,                       -- machine-readable; UI REQ-OP-3 renders this
  detail      JSONB NOT NULL,                      -- incl. actor, event_id refs, pre-state snapshots
  trace_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_by_workflow ON audit_event (workflow_id, seq);

-- Append-only enforcement for the single-application-role deployment of this
-- phase (contract §A.4 grant policy is dual-role; a trigger is the honest
-- equivalent when one role owns the schema): UPDATE/DELETE are refused at the
-- database level, mirroring AT-10's assertion.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% is forbidden)', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TRIGGER processed_events_append_only
  BEFORE UPDATE OR DELETE ON processed_events
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
