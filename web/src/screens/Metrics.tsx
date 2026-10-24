/* Metrics & Health. Every figure is a series the /metrics collector actually
   registers — nothing more. Prometheus counters are shown as durable totals;
   there is no time-series history endpoint (gap G4), so no sparklines or
   rate(Δ) curves are drawn. The raw exposition snapshot is listed exhaustively
   so an operator can always see the ground truth.

   Built on: same Recharts chart primitives as Overview, shadcn Table for
   the raw-series ledger, kit PageHeader/KpiCard/Panel for chrome. */
import { useMemo } from "react";
import { Link } from "react-router";
import {
  AlertOctagon,
  Check,
  ListChecks,
  MailWarning,
  Play,
  Plug,
  TriangleAlert,
} from "lucide-react";

import { useHealthz, useMetrics, useReadyz } from "../api/hooks";
import { byLabel, gaugeValue, workflowCensus } from "../api/prom";
import {
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingRows,
  PageHeader,
  Panel,
  SnapshotAt,
  TimeText,
  humanDuration,
} from "../components/ui";
import {
  BarList,
  Donut,
  GaugeRing,
  TransitionBars,
} from "../components/charts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Sample } from "../api/prom";

const ACTIVE = [
  "QUEUED",
  "RUNNING",
  "RETRY_WAITING",
  "COMPENSATING",
  "CANCELLING",
];
const NEGATIVE = ["FAILED", "ABORTED"];

function fmtVal(name: string, v: number): string {
  if (name.endsWith("_age_seconds") || name.endsWith("_lag_seconds"))
    return humanDuration(v * 1000);
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

export function Metrics() {
  const metrics = useMetrics();
  const readyz = useReadyz();
  const healthz = useHealthz();

  const map = metrics.data;
  const census = map ? workflowCensus(map) : [];
  const byState = new Map<string, number>();
  for (const r of census)
    byState.set(r.state, (byState.get(r.state) ?? 0) + r.count);
  const total = [...byState.values()].reduce((a, b) => a + b, 0);
  const slices = [...byState.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count);

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
    return (fam?.samples ?? []).map((s: Sample) => ({
      key: s.labels.relay ?? "relay",
      value: Math.round(s.value * 1000) / 1000,
    }));
  }, [map]);

  const relayUnacked = useMemo(() => {
    const fam = map?.["fathom_relay_unacked_rows"];
    return (fam?.samples ?? []).map((s: Sample) => ({
      key: s.labels.relay ?? "relay",
      value: s.value,
    }));
  }, [map]);

  const oldestOpen = map
    ? gaugeValue(map, "fathom_oldest_open_workflow_age_seconds")
    : null;
  const oldestDlq = map
    ? gaugeValue(map, "fathom_dlq_oldest_age_seconds")
    : null;
  const outboxDepth = map
    ? gaugeValue(map, "fathom_outbox_unpublished_count")
    : null;
  const outboxAge = map
    ? gaugeValue(map, "fathom_outbox_oldest_unpublished_age_seconds")
    : null;
  const leases = map ? gaugeValue(map, "fathom_worker_leases_held") : null;
  const dlqDepth = map ? byLabel(map, "fathom_dlq_depth", "class") : [];
  const classified = map
    ? byLabel(map, "fathom_events_classified_total", "classification")
    : [];

  const active = ACTIVE.reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  const failed = NEGATIVE.reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  const completed = byState.get("COMPLETED") ?? 0;
  const openDlq = dlqDepth.reduce((a, r) => a + r.value, 0);

  const rawRows = map
    ? Object.values(map)
        .filter((fam) => fam.name.startsWith("fathom_"))
        .flatMap((fam) => fam.samples.map((s) => ({ fam: fam.name, s })))
    : [];

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <PageHeader
        kicker="Telemetry"
        title="Metrics & Health"
        sub={
          <>
            Live scrape of the control plane’s own Prometheus series. Totals are
            durable counters; gauge ages are measured against their operational
            budget.
          </>
        }
        side={
          <>
            {metrics.dataUpdatedAt > 0 && (
              <SnapshotAt updatedAt={metrics.dataUpdatedAt} />
            )}
            <span
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              role="status"
            >
              <Plug className="size-3.5" aria-hidden="true" />
              {healthz.data ? "liveness ok" : "no liveness"} · readyz:{" "}
              {readyz.data?.status ?? "…"}
              {readyz.data?.reason ? ` (${readyz.data.reason})` : ""}
            </span>
          </>
        }
      />

      {metrics.isLoading && (
        <Panel>
          <LoadingRows rows={4} />
        </Panel>
      )}
      {metrics.isError && (
        <Panel>
          <ErrorState error={metrics.error} onRetry={() => metrics.refetch()} />
        </Panel>
      )}

      {map && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 max-xl:[&>*:last-child:nth-child(odd)]:col-span-2 lg:grid-cols-3 xl:grid-cols-5">
            <KpiCard
              index={0}
              kicker="Total workflows"
              value={total}
              sub={total > 0 ? "durable census" : "no data yet"}
              icon={<ListChecks className="size-4" />}
              tone="neutral"
            />
            <KpiCard
              index={1}
              kicker="Completed"
              value={completed}
              sub="terminal · immutable"
              icon={<Check className="size-4" />}
              tone="completed"
            />
            <KpiCard
              index={2}
              kicker="Active"
              value={active}
              sub="queued · running · compensating"
              icon={<Play className="size-4" />}
              tone="running"
            />
            <KpiCard
              index={3}
              kicker="Failed / aborted"
              value={failed}
              sub="terminal · negative"
              icon={<AlertOctagon className="size-4" />}
              tone="negative"
            />
            <KpiCard
              index={4}
              kicker="Dead letters"
              value={openDlq}
              sub={
                <Link
                  to="/dlq"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  investigate →
                </Link>
              }
              icon={<MailWarning className="size-4" />}
              tone="manual"
            />
          </div>

          <div className="mb-5 grid gap-4 lg:grid-cols-2">
            <Panel
              title={<h2>Workflow census</h2>}
              kicker="fathom_workflows_total"
            >
              <Donut slices={slices} total={total} />
            </Panel>
            <Panel
              title={<h2>Transitions</h2>}
              kicker="fathom_workflow_transitions_total · by edge"
            >
              <TransitionBars rows={transitions} />
            </Panel>
          </div>

          <div className="mb-5 grid gap-4 lg:grid-cols-3">
            <Panel
              title={<h2>Ingress</h2>}
              kicker="fathom_events_classified_total"
            >
              <BarList
                rows={classified}
                emptyText="No events classified yet."
              />
            </Panel>
            <Panel title={<h2>Dead-letter depth</h2>} kicker="fathom_dlq_depth">
              {dlqDepth.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Dead-letter queue is empty.
                </p>
              ) : (
                <BarList rows={dlqDepth} tone="violet" />
              )}
            </Panel>
            <Panel
              title={<h2>Relay publish lag</h2>}
              kicker="fathom_relay_publish_lag_seconds"
            >
              {relayLag.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No relay registered with this process.
                </p>
              ) : (
                <BarList rows={relayLag} tone="teal" />
              )}
            </Panel>
          </div>

          <Panel
            className="mb-5"
            title={<h2>Ageing &amp; backlog</h2>}
            kicker="bounded gauges"
          >
            <div className="flex flex-wrap items-center gap-x-8 gap-y-6">
              <GaugeRing
                value={oldestOpen}
                max={3600}
                label="Oldest open workflow (1 h)"
              />
              <GaugeRing
                value={oldestDlq}
                max={86400}
                label="Oldest dead letter (24 h)"
              />
              <GaugeRing
                value={outboxAge}
                max={300}
                label="Oldest unpublished outbox (5 m)"
              />
              <div className="flex min-w-48 flex-1 flex-col gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Outbox backlog
                  </span>
                  <span className="font-mono text-lg leading-none font-semibold text-foreground tabular-nums">
                    {outboxDepth ?? "—"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    rows awaiting relay
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Live step leases
                  </span>
                  <span className="font-mono text-lg leading-none font-semibold text-foreground tabular-nums">
                    {leases ?? "—"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    held by workers
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Relay un-acked rows
                  </span>
                  <span className="font-mono text-lg leading-none font-semibold text-foreground tabular-nums">
                    {relayUnacked.reduce((a, r) => a + r.value, 0) || "0"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    across relays
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Last metrics scrape
                  </span>
                  {metrics.dataUpdatedAt > 0 ? (
                    <TimeText
                      iso={new Date(metrics.dataUpdatedAt).toISOString()}
                      timeOnly
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">…</span>
                  )}
                </div>
              </div>
            </div>
          </Panel>

          <Panel
            title={<h2>Raw series</h2>}
            kicker="every fathom_* sample served"
            bodyClass="p-0"
          >
            {rawRows.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  icon={<TriangleAlert className="size-5" />}
                  title="No fathom_-prefixed series yet"
                  hint="The process registers its metric series once the engine has state to report."
                />
              </div>
            ) : (
              <Table>
                <caption className="sr-only">
                  All <code>fathom_</code>-prefixed metric series in this scrape
                </caption>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs text-muted-foreground uppercase tracking-wide">
                      Series
                    </TableHead>
                    <TableHead className="text-xs text-muted-foreground uppercase tracking-wide">
                      Labels
                    </TableHead>
                    <TableHead className="text-right text-xs text-muted-foreground uppercase tracking-wide">
                      Value
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rawRows.map(({ fam, s }, i) => (
                    <TableRow key={`${fam}-${i}`}>
                      <TableCell className="font-mono text-foreground">
                        {fam}
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground">
                        {Object.entries(s.labels)
                          .map(([k, v]) => `${k}="${v}"`)
                          .join(" ") || "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {fmtVal(fam, s.value)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
