-- Phase 5 — worker execution, recovery scheduler, HTTP API & outbox relay.
-- Additive only: 0001 is an already-applied migration and is NEVER edited in
-- place (brief §7); this versioned migration adds what the Phase-5 features
-- need, each with a documented reason:
--
--  * workflow_definition (DATA §A.1 — contract table deferred by Phase 4's
--    scope note): the API registers definitions and pins a snapshot at create;
--    W1 needs a validated source of steps beyond the client request body.
--  * relay_checkpoint (DATA §A.2): pgoutbox relays keep independent durable
--    cursors (SM §6); without it relay progress dies with the process.
--  * operator_action (DATA §A.4): the authorization/audit record for
--    W17/W18/replay (PRODUCT REQ-OP-5, THREAT T-04).
--  * step timeout/task columns: response_deadline_at/compensation_deadline_at
--    exist since 0001 but had no writer (PHASE_5_SPEC_CHECKLIST §2.3). The
--    durations are definition data (SM §1/§8) stamped by the store at issue
--    time with DATABASE clock arithmetic; compensator_task names the reverse
--    edge's participant task (SM §1 compensator{task}) so the scheduler never
--    hard-codes domain logic (brief §3).
--  * outbox claim columns (brief §7): a relay must claim rows durably across
--    instances without holding a transaction open over network I/O — the
--    claim owner/expiry is what makes a stale relay's ACK impossible and
--    crash-before-ack redeliverable. retry_count/next_retry_at/failed_at are
--    the bounded per-row delivery policy.
-- Note: golang-migrate runs each file inside one transaction; no BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- A.1 Definitions
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_definition (
  name        TEXT NOT NULL,
  version     INT  NOT NULL,
  steps       JSONB NOT NULL,          -- ordered array per SM §1; validated by the engine layer, not the schema
  status      TEXT NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);

-- ---------------------------------------------------------------------------
-- A.2 Relay checkpoints (SM §6: per-relay independent cursors)
-- ---------------------------------------------------------------------------

CREATE TABLE relay_checkpoint (
  relay_name TEXT PRIMARY KEY,                  -- 'pgoutbox-1', … — one per relay instance
  last_seq   BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- A.4 Operator actions (W17/W18 authorization + audit record)
-- ---------------------------------------------------------------------------

CREATE TABLE operator_action (
  id           UUID PRIMARY KEY,
  workflow_id  UUID NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  actor        TEXT NOT NULL,                   -- authenticated key label; never a fabricated identity
  role         TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN
                 ('cancel','retry-now','force-terminate','complete-compensation','replay')),
  reason       TEXT NOT NULL CHECK (length(reason) >= 8),
  dry_run      BOOL NOT NULL,
  pre_snapshot JSONB NOT NULL,                  -- state/version before the action (REQ-OP-5)
  result       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operator_action_by_workflow ON operator_action (workflow_id, created_at);

-- ---------------------------------------------------------------------------
-- Step: per-step durations and the compensator's task name (SM §1/§8)
-- ---------------------------------------------------------------------------

ALTER TABLE step
  ADD COLUMN forward_timeout_secs      INT  NOT NULL DEFAULT 60 CHECK (forward_timeout_secs >= 1),
  ADD COLUMN compensation_timeout_secs INT  NOT NULL DEFAULT 60 CHECK (compensation_timeout_secs >= 1),
  ADD COLUMN compensator_task          TEXT;    -- NULL => the step's own task compensates

-- ---------------------------------------------------------------------------
-- Outbox: durable per-row relay claim + bounded delivery policy (brief §7)
-- ---------------------------------------------------------------------------

ALTER TABLE outbox
  ADD COLUMN claimed_by     TEXT,        -- relay instance that owns the current claim
  ADD COLUMN claimed_until  TIMESTAMPTZ, -- DB-clock claim lease; expired claims are reclaimable
  ADD COLUMN retry_count    INT NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  ADD COLUMN next_retry_at  TIMESTAMPTZ, -- per-row backoff (NULL => immediately retriable)
  ADD COLUMN failed_at      TIMESTAMPTZ; -- permanently failed delivery; excluded from claims

CREATE INDEX outbox_claimable ON outbox (seq)
  WHERE published_at IS NULL AND failed_at IS NULL;  -- relay batch scan base

-- ---------------------------------------------------------------------------
-- API idempotency: the stored response must replay BYTE-IDENTICAL (DATA §D).
-- JSONB re-renders (whitespace, key order), so the body column is TEXT;
-- headers stay JSONB because a map has no byte order to preserve.
-- ---------------------------------------------------------------------------

ALTER TABLE api_idempotency
  ALTER COLUMN response_body TYPE TEXT USING response_body::text;
