-- Phase 5 down: reverses 0002 exactly (drop in reverse dependency order).
-- Everything added by 0002 is Phase-5 runtime data; dropping it is destructive
-- and only ever run against a throwaway database (the Phase-4 round-trip
-- discipline, proven by TestStore_MigrateDownRoundTrip extended in 0002).

DROP INDEX IF EXISTS outbox_claimable;

ALTER TABLE outbox
  DROP COLUMN claimed_by,
  DROP COLUMN claimed_until,
  DROP COLUMN retry_count,
  DROP COLUMN next_retry_at,
  DROP COLUMN failed_at;

ALTER TABLE step
  DROP COLUMN forward_timeout_secs,
  DROP COLUMN compensation_timeout_secs,
  DROP COLUMN compensator_task;

ALTER TABLE api_idempotency
  ALTER COLUMN response_body TYPE JSONB USING response_body::jsonb;

DROP TABLE IF EXISTS operator_action;
DROP TABLE IF EXISTS relay_checkpoint;
DROP TABLE IF EXISTS workflow_definition;
