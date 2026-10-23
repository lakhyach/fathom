-- 0001_durable_core.down.sql — full reversal of the durable-core schema.
-- Drop order mirrors dependency direction (ledger/outbox first, workflow last;
-- step/attempt cascade with workflow but are dropped explicitly for clarity).

DROP TRIGGER IF EXISTS processed_events_append_only ON processed_events;
DROP TRIGGER IF EXISTS audit_event_append_only ON audit_event;
DROP FUNCTION IF EXISTS forbid_ledger_mutation();

DROP TABLE IF EXISTS attempt;
DROP TABLE IF EXISTS step;
DROP TABLE IF EXISTS processed_events;
DROP TABLE IF EXISTS inbound_event;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS api_idempotency;
DROP TABLE IF EXISTS dead_letter;
DROP TABLE IF EXISTS audit_event;
DROP TABLE IF EXISTS workflow;
