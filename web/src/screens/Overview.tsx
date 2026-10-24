/* Overview dashboard. Every number is a live fact: the state census comes
   from fathom_workflows_total (a durable DB GROUP BY), recent activity from
   the newest page of GET /workflows, operational signals from the wired series.
   No sparkline trends exist to show (gap G4) — none are drawn. Phase 7 rebuild
   on Glacier Glass: Tailwind layout, shadcn Alert, kit KpiCard/Panel/HealthPill,
   Recharts census. */
import { Link } from "react-router";
import { AlertOctagon, Check, Clock, ListChecks, Play, TriangleAlert } from "lucide-react";

import { useMetrics, useReadyz, useWorkflows } from "../api/hooks";
import { byLabel, gaugeValue, workflowCensus } from "../api/prom";
import { workflowStatus } from "../theme/status";
import {
  EmptyState,
  ErrorState,
  HealthPill,
  KpiCard,
  LoadingRows,
  PageHeader,
  Panel,
  RelTime,
  SnapshotAt,
  StatusBadge,
  TimeText,
} from "../components/ui";
import { BarList, Donut, GaugeRing } from "../components/charts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const ACTIVE = ["QUEUED", "RUNNING", "RETRY_WAITING", "COMPENSATING", "CANCELLING"];
const NEGATIVE = ["FAILED", "ABORTED"];

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
    <div className="mx-auto w-full max-w-[1400px]">
      <PageHeader
        kicker="Control plane"
        title="Overview"
        sub="Durable census from the engine's own series — counts reflect every workflow ever created, grouped by their current state."
        side={
          <>
            {metrics.dataUpdatedAt > 0 && <SnapshotAt updatedAt={metrics.dataUpdatedAt} />}
            <HealthPill tone={readyness.tone} label={readyness.label} />
          </>
        }
      />

      {degraded && (
        <Alert variant="destructive" className="mb-5 border-st-negative/40 bg-st-negative/5">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Control plane degraded</AlertTitle>
          <AlertDescription>
            {readyness.label}. Workflow state below is the last known census; new placements may not
            advance until readiness recovers.
          </AlertDescription>
        </Alert>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {metrics.isError ? (
          <div className="sm:col-span-2 xl:col-span-5">
            <ErrorState error={metrics.error} onRetry={() => metrics.refetch()} />
          </div>
        ) : metrics.isLoading ? (
          <div className="sm:col-span-2 xl:col-span-5">
            <LoadingRows rows={2} />
          </div>
        ) : (
          <>
            <KpiCard index={0} kicker="Total workflows" value={total} sub={census.length > 0 ? "live census" : "no data yet"} icon={<ListChecks className="size-4" />} tone="neutral" />
            <KpiCard index={1} kicker="Completed" value={completed} sub="terminal · immutable" icon={<Check className="size-4" />} tone="completed" />
            <KpiCard index={2} kicker="Active" value={active} sub="queued · running · retry · compensating" icon={<Play className="size-4" />} tone="running" />
            <KpiCard index={3} kicker="Failed / aborted" value={failed} sub="terminal · negative" icon={<AlertOctagon className="size-4" />} tone="negative" />
            <KpiCard
              index={4}
              kicker="Manual intervention"
              value={manual}
              sub={<Link to="/dlq" className="text-primary underline-offset-4 hover:underline">open dead letters →</Link>}
              icon={<TriangleAlert className="size-4" />}
              tone="manual"
            />
          </>
        )}
      </div>

      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <Panel title={<h2>State census</h2>} kicker="fathom_workflows_total">
          <Donut slices={slices} total={total} />
        </Panel>

        <Panel
          title={<h2>Recent activity</h2>}
          kicker="newest first"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/workflows">View all</Link>
            </Button>
          }
          bodyClass="p-0"
        >
          {recent.isLoading && <div className="p-5"><LoadingRows rows={5} /></div>}
          {recent.isError && <div className="p-5"><ErrorState error={recent.error} onRetry={() => recent.refetch()} /></div>}
          {recent.data && recent.data.items.length === 0 && (
            <div className="p-5">
              <EmptyState
                icon={<Clock className="size-5" />}
                title="No workflows yet"
                hint="Create one with “New workflow” above — the engine queues it and a worker picks it up within seconds."
              />
            </div>
          )}
          {recent.data && recent.data.items.length > 0 && (
            <ul className="flex flex-col">
              {recent.data.items.map((w) => (
                <li key={w.id}>
                  <Link
                    to={`/workflows/${w.id}`}
                    className="flex items-center gap-3 border-b border-border/40 px-5 py-3 transition-colors last:border-b-0 hover:bg-accent/50"
                  >
                    <span className={`size-2 shrink-0 rounded-full`} style={{ background: `var(--st-${workflowStatus(w.state).tone})` }} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {w.def_name} <span className="font-mono text-xs text-muted-foreground">v{w.def_version}</span>
                      </span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">{w.business_key}</span>
                    </span>
                    <StatusBadge state={w.state} size="sm" />
                    <span className="w-16 shrink-0 text-right text-xs text-muted-foreground"><RelTime iso={w.created_at} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={<h2>Ingress classification</h2>} kicker="fathom_events_classified_total">
          <BarList rows={classified} emptyText="No inbound events classified yet." />
        </Panel>

        <Panel title={<h2>Dead-letter depth</h2>} kicker="fathom_dlq_depth">
          {dlqDepth.length === 0 ? (
            <p className="text-xs text-muted-foreground">Queue is empty — nothing awaits manual intervention.</p>
          ) : (
            <BarList rows={dlqDepth} tone="violet" />
          )}
        </Panel>

        <Panel title={<h2>System pulse</h2>} kicker="bounded gauges">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
            <GaugeRing value={oldestOpen} max={3600} label="Oldest open workflow (budget 1 h)" />
            <div className="flex min-w-32 flex-1 flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Outbox backlog</span>
                <span className="font-mono text-lg leading-none font-semibold text-foreground tabular-nums">{outboxDepth ?? "—"}</span>
                <span className="text-xs text-muted-foreground">rows awaiting relay publish</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Live step leases</span>
                <span className="font-mono text-lg leading-none font-semibold text-foreground tabular-nums">{leases ?? "—"}</span>
                <span className="text-xs text-muted-foreground">claimed by worker pools</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Last readyz probe</span>
                {readyz.dataUpdatedAt > 0 ? <TimeText iso={new Date(readyz.dataUpdatedAt).toISOString()} timeOnly /> : <span className="text-xs text-muted-foreground">…</span>}
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
