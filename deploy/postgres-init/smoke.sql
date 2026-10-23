-- CDC smoke fixture — NOT the product schema (docs/DATA_AND_API_CONTRACTS.md
-- defines the real outbox). This minimal table exists only to prove the pinned
-- Debezium Postgres connector + Outbox EventRouter SMT work against
-- apache/kafka:4.3.1, which is the relay's CDC-mode assumption (ADR-006/007).

CREATE SCHEMA IF NOT EXISTS smoke;

CREATE TABLE smoke.outbox (
    id             TEXT PRIMARY KEY,
    aggregate_type TEXT NOT NULL,       -- substituted into ${routedByValue}
    aggregate_id   TEXT NOT NULL,
    type           TEXT NOT NULL,       -- event type, placed on the Kafka header
    payload        JSONB NOT NULL,
    created_on     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inserts do not require FULL identity, but set it so the smoke covers the same
-- row-identity config the product outbox will use.
ALTER TABLE smoke.outbox REPLICA IDENTITY FULL;
