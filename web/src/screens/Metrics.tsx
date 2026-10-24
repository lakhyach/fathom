/* Metrics & system health. This renders the eleven fathom_* series the
   collector actually registers — nothing more. Prometheus counters are shown
   as durable totals; there is no time-series history endpoint (gap G4), so no
   sparklines or rate(Δ) curves are drawn. The raw exposition snapshot is
   listed exhaustively so an operator can always see the ground truth. */
import { useMemo, type CSSProperties } from "react";
import { Link } from "react-router";

import { useHealthz, useMetrics, useReadyz } from "../api/hooks";
import { byLabel, gaugeValue, workflowCensus } from "../api/prom";
import { EmptyState, ErrorState, KpiCard, LoadingRows, Panel, SnapshotAt, TimeText, humanDuration } from "../components/ui";
import { BarList, Donut, GaugeRing, TransitionBars } from "../components/charts";
import { IconAlert, IconCheck, IconDeadLetter, IconExecution, IconPlug, IconWorkflows } from "../icons";
import type { Sample } from "../api/prom";
import "./screens.css";

const rise = (i: number) => ({ className: "fx-rise", style: { "--fx-rise-i": i } as CSSProperties });

const ACTIVE = ["QUEUED", "RUNNING", "RETRY_WAITING", "COMPENSATING", "CANCELLING"];
const NEGATIVE = ["FAILED", "ABORTED"];

function fmtVal(name: string, v: number): string {
  if (name.endsWith("_age_seconds") || name.endsWith("_lag_seconds")) return humanDuration(v * 1000);
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

export function Metrics() {
  const metrics = useMetrics();
  const readyz = useReadyz();
  const healthz = useHealthz();

  const map = metrics.data;
  const census = map ? workflowCensus(map) : [];
  const byState = new Map<string, number>();
  for (const r of census) byState.set(r.state, (byState.get(r.state) ?? 0) + r.count);
  const total = [...byState.values()].reduce((a, b) => a + b, 0);
  const slices = [...byState.entries()].map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count);

  const transitions = useMemo(() => {
    const fam = map?.["fathom_workflow_transitions_total"];
    if (!fam) return [];
    const agg = new Map<string, { from: string; to: string; count: number }>();
    for (const s of fam.samples) {
      const from = s.labels.from ?? "";
      const to = s.labels.to ?? "";
      const k = `${from}→${to}`;
      const cur = agg.get(k) ?? { from, to, count: 0 };
      cur.count += s.value;
      agg.set(k, cur);
    }
    return [...agg.values()].sort((a, b) => b.count - a.count);
  }, [map]);

  const relayLag = useMemo(() => {
    const fam = map?.["fathom_relay_publish_lag_seconds"];
    return (fam?.samples ?? []).map((s: Sample) => ({ key: s.labels.relay ?? "relay", value: Math.round(s.value * 1000) / 1000 }));
  }, [map]);

  const relayUnacked = useMemo(() => {
    const fam = map?.["fathom_relay_unacked_rows"];
    return (fam?.samples ?? []).map((s: Sample) => ({ key: s.labels.relay ?? "relay", value: s.value }));
  }, [map]);

  const oldestOpen = map ? gaugeValue(map, "fathom_oldest_open_workflow_age_seconds") : null;
  const oldestDlq = map ? gaugeValue(map, "fathom_dlq_oldest_age_seconds") : null;
  const outboxDepth = map ? gaugeValue(map, "fathom_outbox_unpublished_count") : null;
  const outboxAge = map ? gaugeValue(map, "fathom_outbox_oldest_unpublished_age_seconds") : null;
  const leases = map ? gaugeValue(map, "fathom_worker_leases_held") : null;
  const dlqDepth = map ? byLabel(map, "fathom_dlq_depth", "class") : [];
  const classified = map ? byLabel(map, "fathom_events_classified_total", "classification") : [];

  const active = ACTIVE.reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  const failed = NEGATIVE.reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  const completed = byState.get("COMPLETED") ?? 0;
  const openDlq = dlqDepth.reduce((a, r) => a + r.value, 0);

  return (
    <div className="fx-screen">
      <div className="fx-page-head">
        <div>
          <span className="kicker">Telemetry</span>
          <h1>Metrics &amp; Health</h1>
          <p className="fx-page-sub">
            Live scrape of the control plane’s own Prometheus series. Totals are durable counters; gauge
            ages are measured against their operational budget.
          </p>
        </div>
        <div className="fx-page-head__side">
          {metrics.dataUpdatedAt > 0 && <SnapshotAt updatedAt={metrics.dataUpdatedAt} />}
          <span className={`fx-ready fx-ready--${readyz.data?.status ?? "unknown"}`}>
            <IconPlug size={11} /> {healthz.data ? "liveness ok" : "no liveness"} · readyz: {readyz.data?.status ?? "…"}
            {readyz.data?.reason ? ` (${readyz.data.reason})` : ""}
          </span>
        </div>
      </div>

      {metrics.isLoading && <Panel><LoadingRows rows={4} /></Panel>}
      {metrics.isError && <Panel><ErrorState error={metrics.error} onRetry={() => metrics.refetch()} /></Panel>}

      {map && (
        <>
          <div className="fx-kpi">
            <KpiCard index={0} kicker="Total workflows" value={total} sub={total > 0 ? "durable census" : "no data yet"} icon={<IconWorkflows size={16} />} tone="neutral" />
            <KpiCard index={1} kicker="Completed" value={completed} sub="terminal · immutable" icon={<IconCheck size={16} />} tone="completed" />
            <KpiCard index={2} kicker="Active" value={active} sub="queued · running · compensating" icon={<IconExecution size={16} />} tone="running" />
            <KpiCard index={3} kicker="Failed / aborted" value={failed} sub="terminal · negative" icon={<IconAlert size={16} />} tone="negative" />
            <KpiCard
              index={4}
              kicker="Dead letters"
              value={openDlq}
              sub={<Link to="/dlq">investigate →</Link>}
              icon={<IconDeadLetter size={16} />}
              tone="manual"
            />
          </div>

          <div className="fx-grid-2">
            <Panel {...rise(0)} title={<h2>Workflow census</h2>} kicker="fathom_workflows_total">
              <Donut slices={slices} total={total} />
            </Panel>
            <Panel {...rise(1)} title={<h2>Transitions</h2>} kicker="fathom_workflow_transitions_total · by edge">
              <TransitionBars rows={transitions} />
            </Panel>
          </div>

          <div className="fx-grid-3">
            <Panel {...rise(2)} title={<h2>Ingress</h2>} kicker="fathom_events_classified_total">
              <BarList rows={classified} emptyText="No events classified yet." />
            </Panel>
            <Panel {...rise(3)} title={<h2>Dead-letter depth</h2>} kicker="fathom_dlq_depth">
              {dlqDepth.length === 0 ? <p className="fx-chart-empty">Dead-letter queue is empty.</p> : <BarList rows={dlqDepth} tone="violet" />}
            </Panel>
            <Panel {...rise(4)} title={<h2>Relay publish lag</h2>} kicker="fathom_relay_publish_lag_seconds">
              {relayLag.length === 0 ? <p className="fx-chart-empty">No relay registered with this process.</p> : <BarList rows={relayLag} tone="blue" />}
            </Panel>
          </div>

          <Panel {...rise(5)} title={<h2>Ageing &amp; backlog</h2>} kicker="bounded gauges">
            <div className="fx-pulse-row">
              <GaugeRing value={oldestOpen} max={3600} label="Oldest open workflow (1 h)" />
              <GaugeRing value={oldestDlq} max={86400} label="Oldest dead letter (24 h)" />
              <GaugeRing value={outboxAge} max={300} label="Oldest unpublished outbox (5 m)" />
              <div className="fx-pulse-side">
                <div className="fx-pulse-metric">
                  <span className="kicker">Outbox backlog</span>
                  <span className="fx-pulse-metric__v num">{outboxDepth ?? "—"}</span>
                  <span className="fx-dim">rows awaiting relay</span>
                </div>
                <div className="fx-pulse-metric">
                  <span className="kicker">Live step leases</span>
                  <span className="fx-pulse-metric__v num">{leases ?? "—"}</span>
                  <span className="fx-dim">held by workers</span>
                </div>
                <div className="fx-pulse-metric">
                  <span className="kicker">Relay un-acked rows</span>
                  <span className="fx-pulse-metric__v num">{relayUnacked.reduce((a, r) => a + r.value, 0) || "0"}</span>
                  <span className="fx-dim">across relays</span>
                </div>
                <div className="fx-pulse-metric">
                  <span className="kicker">Last metrics scrape</span>
                  {metrics.dataUpdatedAt > 0 ? <TimeText iso={new Date(metrics.dataUpdatedAt).toISOString()} timeOnly /> : <span className="fx-dim">…</span>}
                </div>
              </div>
            </div>
          </Panel>

          <Panel {...rise(6)} title={<h2>Raw series</h2>} kicker="every fathom_* sample served" bodyClass="fx-panel__body--flush">
            <table className="fx-series-table">
              <caption className="sr-only">All <code>fathom_</code>-prefixed metric series in this scrape</caption>
              <tbody>
                {Object.values(map)
                  .filter((fam) => fam.name.startsWith("fathom_"))
                  .flatMap((fam) => fam.samples.map((s) => ({ fam: fam.name, s })))
                  .map(({ fam, s }, i) => (
                    <tr key={`${fam}-${i}`}>
                      <td>{fam}</td>
                      <td className="mono">{Object.entries(s.labels).map(([k, v]) => `${k}="${v}"`).join(" ") || "—"}</td>
                      <td>{fmtVal(fam, s.value)}</td>
                    </tr>
                  ))}
                {Object.values(map).filter((f) => f.name.startsWith("fathom_") && f.samples.length > 0).length === 0 && (
                  <tr>
                    <td colSpan={3}>
                      <EmptyState title="No fathom_-prefixed series yet" hint="The process registers its metric series once the engine has state to report." />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}
