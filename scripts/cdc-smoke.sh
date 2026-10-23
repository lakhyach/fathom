#!/usr/bin/env bash
# CDC image-pair smoke test — the reproducible check that the pinned
# apache/kafka + Debezium Connect images start, a Postgres+Outbox-EventRouter
# connector reaches RUNNING, and an outbox row is routed to a Kafka topic.
#
# Runs the same steps documented in docs/PHASE_3_VALIDATION_REPORT.md. Used by
# `task cdc:smoke` (Windows Git-bash) and the Linux CI integration job. Requires:
# docker (with compose v2), go, curl. NOT the product deployment.
set -euo pipefail

cd "$(dirname "$0")/.."
# Git-for-Windows' MSYS layer rewrites POSIX paths that look absolute (e.g. the
# /opt/kafka/… script we exec *inside* a container) into Windows paths before
# docker.exe receives them, which breaks `compose exec`. Disabling the
# conversion fixes Windows Git-bash and is a harmless no-op on Linux CI.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
COMPOSE="docker compose -f deploy/docker-compose.smoke.yaml"
CONNECT=http://127.0.0.1:8083
BOOTSTRAP=127.0.0.1:29092

cleanup() {
  echo ">> tearing down smoke stack"
  $COMPOSE down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

die() { echo "SMOKE FAIL: $*" >&2; exit 1; }

echo ">> [1/6] starting stack (waits for healthchecks)"
$COMPOSE up -d --wait || die "compose up"

echo ">> [2/6] franz-go round-trip against the pinned broker"
( cd tools && CGO_ENABLED=0 go run ./kafkasmoke -bootstrap "$BOOTSTRAP" -topic fathom-smoke-rt -n 8 ) \
  || die "kafkasmoke round-trip"

echo ">> [3/6] waiting for the Connect REST API, then registering the connector"
# `up --wait` returns once the container is *running*, but Kafka Connect keeps
# initialising (creating its internal config/offset/status topics, joining the
# group, starting the REST listener) for a while after that. A POST during the
# window returns an empty/failed reply (measured: HTTP 000 then 200). Poll
# GET /connectors until it answers 200 rather than racing the cold start.
for i in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$CONNECT/connectors" || true)"
  if [ "$code" = "200" ]; then echo "   Connect REST ready after ${i} polls"; break; fi
  sleep 3
  [ "$i" -eq 40 ] && die "Connect REST API did not become ready in time"
done
curl -sf -X DELETE "$CONNECT/connectors/fathom-cdc-smoke-connector" >/dev/null 2>&1 || true
curl -sf -X POST "$CONNECT/connectors" -H 'Content-Type: application/json' \
  --data @deploy/debezium/outbox-smoke-connector.json >/dev/null || die "connector register"

echo ">> [4/6] waiting for connector + task RUNNING"
for i in $(seq 1 40); do
  status="$(curl -sf "$CONNECT/connectors/fathom-cdc-smoke-connector/status" || true)"
  if echo "$status" | grep -q '"state":"FAILED"'; then
    echo "$status"; die "connector task FAILED"
  fi
  running="$(echo "$status" | grep -o '"state":"RUNNING"' | wc -l | tr -d ' ')"
  if [ "$running" -ge 2 ]; then echo "   RUNNING after ${i} polls"; break; fi
  sleep 3
  [ "$i" -eq 40 ] && die "connector did not reach RUNNING in time"
done

echo ">> [5/6] inserting an outbox row (streams + re-snapshot path)"
printf "%s\n" \
  "INSERT INTO smoke.outbox (id, aggregate_type, aggregate_id, type, payload) VALUES ('evt-smoke', 'smoke', 'agg-smoke', 'RoomReserved', '{\"wf\":\"fake\",\"ok\":true}');" \
  | $COMPOSE exec -T postgres psql -U fathom -d fathom >/dev/null || die "insert outbox row"

echo ">> [6/6] consuming the routed topic smoke.events"
sleep 5
consumed="$($COMPOSE exec -T kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic smoke.events --from-beginning \
  --max-messages 1 --timeout-ms 30000 --property print.key=true --property print.headers=true 2>/dev/null || true)"
echo "   routed record: $consumed"
echo "$consumed" | grep -q 'agg-smoke' || die "aggregate id not on routed record"
echo "$consumed" | grep -q 'fake'       || die "payload not routed"
echo "$consumed" | grep -q 'eventType'  || die "EventRouter header placement missing"

echo "SMOKE PASS"
