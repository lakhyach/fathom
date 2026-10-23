/* Overview dashboard. Every number is a live fact: the state census comes
   from fathom_workflows_total (a durable DB GROUP BY), recent activity from
   the newest page of GET /workflows, operational signals from the eleven
   wired series. No sparkline trends exist to show (gap G4) — none are drawn. */
import { Link } from "react-router";

import { useMetrics, useReadyz, useWorkflows } from "../api/hooks";
import { byLabel, gaugeValue, workflowCensus } from "../api/prom";
import { workflowStatus, type StatusTone } from "../theme/status";
import { Panel, SnapshotAt, EmptyState, ErrorState, LoadingRows, StatusBadge, TimeText, RelTime } from "../components/ui";
import { BarList, GaugeRing, StateStack } from "../components/charts";
import {
  IconCheck,
  IconClock,
  IconDeadLetter,
  IconPlay,
  IconAlert,
  IconWorkflows,
} from "../icons";
import type { ReactNode } from "react";
import "./screens.css";

const ACTIVE = ["QUEUED", "RUNNING", "RETRY_WAITING", "COMPENSATING", "CANCELLING"];
const NEGATIVE = ["FAILED", "ABORTED"];

function StatCard({ kicker, value, sub, icon, tone }: { kicker: string; value: ReactNode; sub?: ReactNode; icon: ReactNode; tone: StatusTone | "neutral" }) {
  return (
    <div className={`fx-stat fx-stat--${tone} panel`}>
      <div className="fx-stat__icon" aria-hidden="true">{icon}</div>
      <div className="fx-stat__body">
        <span className="kicker">{kicker}</span>
        <span className="fx-stat__value num">{value}</span>
        {sub && <span className="fx-stat__sub">{sub}</span>}
      </div>
    </div>
  );
}

export function Overview() {
  const metrics = useMetrics();
  const recent = useWorkflows({ limit: 8 });
  const readyz = useReadyz();

  // Readiness is a first-class fact: an unreachable /readyz or a 503 must never
  // render as healthy. Green paints only for a genuine status === "ready".
  const readyness = (() => {
    if (readyz.isLoading && !readyz.data) return { tone: "pending" as const, label: "Checking readiness" };
    if (readyz.isError) return { tone: "negative" as const, label: "Control plane unreachable" };
    if (readyz.data?.status === "ready") return { tone: "completed" as const, label: "Ready" };
    const reason = readyz.data?.reason === "db_unavailable" ? "database unavailable"
      : readyz.data?.reason === "relay_lag" ? "event relay lagging"
      : undefined;
    return { tone: "manual" as const, label: reason ? `Degraded · ${reason}` : "Not ready" };
  })();
  const degraded = readyness.tone === "manual" || readyness.tone === "negative";

  const census = metrics.data ? workflowCensus(metrics.data) : [];
  const byState = new Map<string, number>();
  for (const row of census) byState.set(row.state, (byState.get(row.state) ?? 0) + row.count);
  const total = [...byState.values()].reduce((a, b) => a + b, 0);
  const active = ACTIVE.reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  const failed = NEGATIVE.reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  const manual = byState.get("FAILED_MANUAL") ?? 0;
  const completed = byState.get("COMPLETED") ?? 0;

  const slices = [...byState.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count);

  const classified = metrics.data ? byLabel(metrics.data, "fathom_events_classified_total", "classification") : [];
  const dlqDepth = metrics.data ? byLabel(metrics.data, "fathom_dlq_depth", "class") : [];
  const oldestOpen = metrics.data ? gaugeValue(metrics.data, "fathom_oldest_open_workflow_age_seconds") : null;
  const outboxDepth = metrics.data ? gaugeValue(metrics.data, "fathom_outbox_unpublished_count") : null;
  const leases = metrics.data ? gaugeValue(metrics.data, "fathom_worker_leases_held") : null;

  return (
    <div className="fx-screen">
      <div className="fx-page-head">
        <div>
          <span className="kicker">Control plane</span>
          <h1>Overview</h1>
          <p className="fx-page-sub">
            Durable census from the engine's own series — counts reflect every workflow ever created,
            grouped by their current state.
          </p>
        </div>
        <div className="fx-page-head__side">
          {metrics.dataUpdatedAt > 0 && <SnapshotAt updatedAt={metrics.dataUpdatedAt} />}
          <span className={`fx-health fx-health--${readyness.tone}`} role="status">
            <span className="fx-health__dot" aria-hidden="true" />
            {readyness.label}
          </span>
        </div>
      </div>

      {degraded && (
        <div className="fx-banner fx-banner--degraded" role="alert">
          <IconAlert size={18} aria-hidden="true" />
          <div>
            <strong>Control plane degraded</strong>
            <span> {readyness.label}. Workflow state below is the last known census; new placements may not advance until readiness recovers.</span>
          </div>
        </div>
      )}

      <div className="fx-stats">
        {metrics.isError ? (
          <div className="fx-stats__err">
            <ErrorState error={metrics.error} onRetry={() => metrics.refetch()} />
          </div>
        ) : metrics.isLoading ? (
          <LoadingRows rows={2} />
        ) : (
          <>
            <StatCard kicker="Total workflows" value={total} sub={`${census.length > 0 ? "live census" : "no data yet"}`} icon={<IconWorkflows size={18} />} tone="neutral" />
            <StatCard kicker="Completed" value={completed} sub="terminal · immutable" icon={<IconCheck size={18} />} tone="completed" />
            <StatCard kicker="Active" value={active} sub="queued · running · retry · compensating · cancelling" icon={<IconPlay size={18} />} tone="running" />
            <StatCard kicker="Failed / aborted" value={failed} sub="terminal · negative" icon={<IconAlert size={18} />} tone="negative" />
            <StatCard
              kicker="Manual intervention"
              value={manual}
              sub={<Link to="/dlq">open dead letters →</Link>}
              icon={<IconDeadLetter size={18} />}
              tone="manual"
            />
          </>
        )}
      </div>

      <div className="fx-grid-2">
        <Panel title={<h2>State census</h2>} kicker="fathom_workflows_total">
          <StateStack slices={slices} total={total} />
        </Panel>

        <Panel
          title={<h2>Recent activity</h2>}
          kicker="newest first"
          actions={
            <Link className="btn btn-sm" to="/workflows">
              View all
            </Link>
          }
          bodyClass="fx-panel__body--flush"
        >
          {recent.isLoading && <LoadingRows rows={5} />}
          {recent.isError && <div style={{ padding: 16 }}><ErrorState error={recent.error} onRetry={() => recent.refetch()} /></div>}
          {recent.data && recent.data.items.length === 0 && (
            <EmptyState
              icon={<IconClock size={20} />}
              title="No workflows yet"
              hint="Create one with “New workflow” above — the engine queues it and a worker picks it up within seconds."
            />
          )}
          {recent.data && recent.data.items.length > 0 && (
            <ul className="fx-activity">
              {recent.data.items.map((w) => (
                <li key={w.id}>
                  <Link to={`/workflows/${w.id}`} className="fx-activity__row">
                    <span className={`fx-dot fx-dot--${workflowStatus(w.state).tone}`} aria-hidden="true" />
                    <span className="fx-activity__main">
                      <span className="fx-activity__title">
                        {w.def_name} <span className="fx-dim mono">v{w.def_version}</span>
                      </span>
                      <span className="fx-activity__key mono">{w.business_key}</span>
                    </span>
                    <StatusBadge state={w.state} size="sm" />
                    <span className="fx-activity__time"><RelTime iso={w.created_at} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="fx-grid-3">
        <Panel title={<h2>Ingress classification</h2>} kicker="fathom_events_classified_total">
          <BarList rows={classified} emptyText="No inbound events classified yet." />
        </Panel>

        <Panel title={<h2>Dead-letter depth</h2>} kicker="fathom_dlq_depth">
          {dlqDepth.length === 0 ? (
            <p className="fx-chart-empty">Queue is empty — nothing awaits manual intervention.</p>
          ) : (
            <BarList rows={dlqDepth} tone="violet" />
          )}
        </Panel>

        <Panel title={<h2>System pulse</h2>} kicker="bounded gauges">
          <div className="fx-pulse-row">
            <GaugeRing value={oldestOpen} max={3600} label="Oldest open workflow (budget 1 h)" />
            <div className="fx-pulse-side">
              <div className="fx-pulse-metric">
                <span className="kicker">Outbox backlog</span>
                <span className="fx-pulse-metric__v num">{outboxDepth ?? "—"}</span>
                <span className="fx-dim">rows awaiting relay publish</span>
              </div>
              <div className="fx-pulse-metric">
                <span className="kicker">Live step leases</span>
                <span className="fx-pulse-metric__v num">{leases ?? "—"}</span>
                <span className="fx-dim">claimed by worker pools</span>
              </div>
              <div className="fx-pulse-metric">
                <span className="kicker">Last readyz probe</span>
                {readyz.dataUpdatedAt > 0 ? <TimeText iso={new Date(readyz.dataUpdatedAt).toISOString()} timeOnly /> : <span className="fx-dim">…</span>}
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
