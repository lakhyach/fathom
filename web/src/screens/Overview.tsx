/* Overview — the Phase 8 command centre.
   Two data planes, kept visibly apart:
   • the durable census (fathom_workflows_total) answers "what exists now";
   • the placement walk (GET /v1/workflows, cursor-paged client-side) is the
     only thing that carries time, so every trend, percentile and age on this
     screen is computed from those real rows.
   Where a window is only partially covered, or a metric has no sample, the
   panel says so. Nothing here is extrapolated, smoothed or defaulted to zero. */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Activity,
  AlertOctagon,
  ArrowRight,
  Check,
  Inbox,
  Info,
  Layers,
  Play,
  TriangleAlert,
} from "lucide-react";

import {
  PLACEMENT_MAX_PAGES,
  PLACEMENT_PAGE_SIZE,
  useDlq,
  useMetrics,
  usePlacements,
  useReadyz,
  useWorkflows,
} from "../api/hooks";
import { byLabel, gaugeValue, workflowCensus } from "../api/prom";
import { useSettings } from "../state/settings";
import { workflowStatus } from "../theme/status";
import {
  bucketLabel,
  bucketPlacements,
  definitionLedger,
  outcomeSplit,
  percentile,
  wallTimes,
} from "../lib/aggregate";
import {
  ChartLegend,
  Donut,
  DurationBars,
  GaugeRing,
  MixBars,
  TrendChart,
} from "../components/charts";
import {
  ChartEmpty,
  EmptyState,
  ErrorState,
  HealthPill,
  KpiCard,
  LoadingRows,
  MetricRow,
  PageHeader,
  Panel,
  RelTime,
  Segmented,
  SnapshotAt,
  StatusBadge,
  humanDuration,
} from "../components/ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

const ACTIVE = [
  "QUEUED",
  "RUNNING",
  "RETRY_WAITING",
  "COMPENSATING",
  "CANCELLING",
];
const NEGATIVE = ["FAILED", "ABORTED"];

const HOUR = 3600_000;
const RANGES = [
  { value: "1h", label: "1 h", ms: HOUR, bucket: 10 * 60_000 },
  { value: "6h", label: "6 h", ms: 6 * HOUR, bucket: 30 * 60_000 },
  { value: "24h", label: "24 h", ms: 24 * HOUR, bucket: 2 * HOUR },
  { value: "7d", label: "7 d", ms: 7 * 24 * HOUR, bucket: 24 * HOUR },
] as const;
type RangeKey = (typeof RANGES)[number]["value"];

export function Overview() {
  const [range, setRange] = useState<RangeKey>("7d");
  const { timeFormat } = useSettings();
  const utc = timeFormat === "utc";

  const metrics = useMetrics();
  const readyz = useReadyz();
  const recent = useWorkflows({ limit: 8 });
  const placements = usePlacements(7 * 24 * HOUR);
  const dlqPage = useDlq({ limit: 6 });

  /* ---- readiness is a first-class fact: an unreachable /readyz or a 503
     never renders as healthy. Green paints only for status === "ready". ---- */
  const readyness = (() => {
    if (readyz.isLoading && !readyz.data)
      return { tone: "pending" as const, label: "Checking readiness" };
    if (readyz.isError)
      return { tone: "negative" as const, label: "Control plane unreachable" };
    if (readyz.data?.status === "ready")
      return { tone: "completed" as const, label: "Ready" };
    const reason =
      readyz.data?.reason === "db_unavailable"
        ? "database unavailable"
        : readyz.data?.reason === "relay_lag"
          ? "event relay lagging"
          : undefined;
    return {
      tone: "manual" as const,
      label: reason ? `Degraded · ${reason}` : "Not ready",
    };
  })();
  const degraded = readyness.tone === "manual" || readyness.tone === "negative";

  /* ---- durable census: a handful of samples, reduced per render ---- */
  const census = metrics.data ? workflowCensus(metrics.data) : [];
  const byState = new Map<string, number>();
  for (const row of census)
    byState.set(row.state, (byState.get(row.state) ?? 0) + row.count);
  const total = [...byState.values()].reduce((a, b) => a + b, 0);
  const active = ACTIVE.reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  const failed = NEGATIVE.reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  const manual = byState.get("FAILED_MANUAL") ?? 0;
  const completed = byState.get("COMPLETED") ?? 0;
  const terminal = completed + failed + manual;
  const slices = [...byState.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count);
  const defs = definitionLedger(census);

  /* ---- the time plane: real placement rows, bucketed ---- */
  const rows = useMemo(() => placements.data?.rows ?? [], [placements.data]);
  const spec = RANGES.find((r) => r.value === range)!;
  const points = useMemo(
    () =>
      bucketPlacements(rows, {
        rangeMs: spec.ms,
        bucketMs: spec.bucket,
        utc,
      }).map((b) => ({
        ...b,
        t: b.start,
        label: bucketLabel(b.start, spec.ms, utc),
      })),
    [rows, spec.ms, spec.bucket, utc],
  );
  const windowTotal = points.reduce((a, p) => a + p.total, 0);
  const durations = useMemo(() => wallTimes(rows), [rows]);
  const p50 = percentile(
    durations.map((d) => d.ms),
    50,
  );
  const p95 = percentile(
    durations.map((d) => d.ms),
    95,
  );
  const recentSplit = outcomeSplit(recent.data?.items ?? []);

  /* ---- wired signals ---- */
  const dlqDepth = metrics.data
    ? byLabel(metrics.data, "fathom_dlq_depth", "class")
    : [];
  const dlqTotal = dlqDepth.reduce((a, r) => a + r.value, 0);
  const oldestDlq = metrics.data
    ? gaugeValue(metrics.data, "fathom_dlq_oldest_age_seconds")
    : null;
  const oldestOpen = metrics.data
    ? gaugeValue(metrics.data, "fathom_oldest_open_workflow_age_seconds")
    : null;
  const outboxDepth = metrics.data
    ? gaugeValue(metrics.data, "fathom_outbox_unpublished_count")
    : null;
  const outboxAge = metrics.data
    ? gaugeValue(metrics.data, "fathom_outbox_oldest_unpublished_age_seconds")
    : null;
  const leases = metrics.data
    ? gaugeValue(metrics.data, "fathom_worker_leases_held")
    : null;

  return (
    <div className="mx-auto w-full max-w-[1600px]">
      <PageHeader
        kicker="Control plane"
        title="Overview"
        sub="Durable census from the engine's own series, and a placement timeline built from the workflow ledger itself."
        side={
          <>
            {metrics.dataUpdatedAt > 0 && (
              <SnapshotAt updatedAt={metrics.dataUpdatedAt} />
            )}
            <HealthPill tone={readyness.tone} label={readyness.label} />
          </>
        }
      />

      {degraded && (
        <Alert
          variant="destructive"
          className="mb-4 border-st-negative/40 bg-st-negative/5"
        >
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Control plane degraded</AlertTitle>
          <AlertDescription>
            {readyness.label}. Workflow state below is the last known census;
            new placements may not advance until readiness recovers.
          </AlertDescription>
        </Alert>
      )}

      {/* ------------------------------ KPI strip ------------------------------ */}
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:gap-3 max-xl:[&>*:last-child:nth-child(odd)]:col-span-2 lg:grid-cols-3 xl:grid-cols-5">
        {metrics.isError ? (
          <div className="col-span-2 lg:col-span-3 xl:col-span-5">
            <ErrorState
              error={metrics.error}
              onRetry={() => metrics.refetch()}
            />
          </div>
        ) : metrics.isLoading ? (
          <div className="col-span-2 lg:col-span-3 xl:col-span-5">
            <LoadingRows rows={2} />
          </div>
        ) : (
          <>
            <KpiCard
              index={0}
              kicker="Placements"
              value={total}
              sub="every workflow, live census"
              icon={<Layers className="size-4" />}
              tone="neutral"
            />
            <KpiCard
              index={1}
              kicker="Success rate"
              value={
                terminal > 0
                  ? `${Math.round((completed / terminal) * 100)}%`
                  : "—"
              }
              sub={
                terminal > 0
                  ? `${completed} of ${terminal} terminal`
                  : "nothing has reached a terminal state yet"
              }
              icon={<Check className="size-4" />}
              tone="completed"
            />
            <KpiCard
              index={2}
              kicker="Active"
              value={active}
              sub="queued · running · retry · compensating"
              icon={<Play className="size-4" />}
              tone="running"
            />
            <KpiCard
              index={3}
              kicker="Failed / aborted"
              value={failed}
              sub={
                manual > 0 ? (
                  <Link
                    to="/dlq"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {manual} awaiting manual →
                  </Link>
                ) : (
                  "terminal · negative"
                )
              }
              icon={<AlertOctagon className="size-4" />}
              tone="negative"
            />
            <KpiCard
              index={4}
              kicker="Queue depth"
              value={metrics.data ? dlqTotal : "—"}
              sub={
                outboxDepth === null
                  ? "dead letters · outbox unknown"
                  : `dead letters · ${outboxDepth} outbox rows`
              }
              icon={<Inbox className="size-4" />}
              tone={dlqTotal > 0 ? "manual" : "neutral"}
              href="/dlq"
            />
          </>
        )}
      </div>

      {/* ------------------- the signature trend + control plane ------------------- */}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          bodyClass="flex min-h-0 flex-1 flex-col"
          title={<h2>Placement flow</h2>}
          kicker="GET /v1/workflows · outcome per bucket"
          actions={
            <Segmented
              ariaLabel="Trend time range"
              value={range}
              onChange={setRange}
              options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            />
          }
        >
          {placements.isLoading && !placements.data ? (
            <LoadingRows rows={4} />
          ) : placements.isError ? (
            <ErrorState
              error={placements.error}
              onRetry={() => placements.refetch()}
            />
          ) : windowTotal === 0 ? (
            <ChartEmpty
              height={268}
              message={`No workflow was placed in the last ${spec.label.toLowerCase()}. The walk found ${rows.length} placement${rows.length === 1 ? "" : "s"} in total — widen the range if you expected traffic here.`}
            />
          ) : (
            <>
              <TrendChart points={points} fill />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-hairline pt-4">
                <ChartLegend
                  items={[
                    {
                      label: "Completed",
                      tone: "var(--st-completed)",
                      value: points.reduce((a, p) => a + p.completed, 0),
                    },
                    {
                      label: "Failed / aborted",
                      tone: "var(--st-negative)",
                      value: points.reduce((a, p) => a + p.negative, 0),
                    },
                    {
                      label: "Still open",
                      tone: "var(--st-running)",
                      value: points.reduce((a, p) => a + p.open, 0),
                    },
                  ]}
                />
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="group inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-chip hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      {windowTotal} placement{windowTotal === 1 ? "" : "s"} ·{" "}
                      {spec.bucket >= 24 * HOUR
                        ? "daily"
                        : `${Math.round(spec.bucket / 60_000)} min`}{" "}
                      buckets
                      {!placements.data?.covered && (
                        <span className="text-st-warn">· window partial</span>
                      )}
                      <Info className="size-3.5 opacity-60 transition-opacity group-hover:opacity-100" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    side="top"
                    className="w-80 text-[12px] leading-relaxed"
                  >
                    <PopoverHeader>
                      <PopoverTitle className="text-foreground">
                        How this time axis is built
                      </PopoverTitle>
                      <PopoverDescription>
                        <code className="font-mono text-foreground">
                          GET /v1/workflows
                        </code>{" "}
                        has no server-side date filter, so the trend is
                        assembled by walking cursors backwards on the client.
                      </PopoverDescription>
                    </PopoverHeader>
                    <div className="mt-3 space-y-2 text-muted-foreground">
                      <ul className="space-y-1">
                        <li className="flex justify-between gap-3">
                          <span>Page size</span>
                          <span className="font-mono text-foreground tabular-nums">
                            {PLACEMENT_PAGE_SIZE}
                          </span>
                        </li>
                        <li className="flex justify-between gap-3">
                          <span>Page cap</span>
                          <span className="font-mono text-foreground tabular-nums">
                            {PLACEMENT_MAX_PAGES}
                          </span>
                        </li>
                        <li className="flex justify-between gap-3">
                          <span>Rows walked</span>
                          <span className="font-mono text-foreground tabular-nums">
                            {rows.length}
                          </span>
                        </li>
                      </ul>
                      <p>
                        {placements.data?.covered ? (
                          <>
                            The walk reached the start of this{" "}
                            <span className="text-foreground">
                              {spec.label}
                            </span>{" "}
                            window, so the buckets are complete.
                          </>
                        ) : (
                          <span className="text-st-warn">
                            The page cap stopped the walk above the start of
                            this window. The oldest buckets are partial — they
                            are labelled as such, never drawn as zero.
                          </span>
                        )}
                      </p>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </>
          )}
        </Panel>

        <Panel title={<h2>Control plane</h2>} kicker="readyz · /metrics gauges">
          <div className="mb-3 flex items-start justify-around gap-4">
            <GaugeRing
              value={oldestOpen}
              max={3600}
              label="Oldest open workflow (1 h budget)"
            />
            <GaugeRing
              value={oldestDlq}
              max={86400}
              label="Oldest dead letter (24 h)"
            />
          </div>
          <div className="flex flex-col">
            <MetricRow
              label="Readiness"
              tone={readyness.tone}
              value={readyz.data?.status ?? "unknown"}
              hint={
                readyz.data?.reason
                  ? `reason: ${readyz.data.reason}`
                  : "readyz answers 200 only when the relay and database are healthy"
              }
            />
            <MetricRow
              label="Live step leases"
              value={leases ?? "—"}
              hint={
                leases === 0
                  ? "no worker pool currently holds a lease"
                  : "claimed by worker pools"
              }
            />
            <MetricRow
              label="Outbox backlog"
              value={outboxDepth ?? "—"}
              hint="rows awaiting relay publish"
            />
            <MetricRow
              label="Oldest unpublished"
              value={outboxAge === null ? "—" : humanDuration(outboxAge * 1000)}
              hint="age of the oldest waiting outbox row"
            />
          </div>
          <Button asChild variant="outline" size="xs" className="mt-4 w-full">
            <Link to="/metrics">
              Full metrics &amp; health
              <ArrowRight />
            </Link>
          </Button>
        </Panel>
      </div>

      {/* ------------------------ census · volume · latency ------------------------ */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Panel title={<h2>State census</h2>} kicker="fathom_workflows_total">
          {metrics.isLoading ? (
            <LoadingRows rows={4} />
          ) : (
            <Donut slices={slices} total={total} />
          )}
          <p className="mt-5 border-t border-hairline pt-4 text-[11px] leading-relaxed text-muted-foreground">
            A durable <code className="font-mono">GROUP BY</code> over the
            workflow table: {active} open, {terminal} terminal. Counts never
            decay — they cover every workflow this store has created.
          </p>
        </Panel>

        <Panel
          title={<h2>Volume by definition</h2>}
          kicker="fathom_workflows_total · def_name"
        >
          {defs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No workflow definitions have produced a placement yet.
            </p>
          ) : (
            <>
              <MixBars rows={defs} />
              <p className="mt-5 border-t border-hairline pt-4 text-[11px] leading-relaxed text-muted-foreground">
                {defs.length} definition{defs.length === 1 ? "" : "s"} appear in
                the census. Bar length ranks by total placements; the split
                shows how each one ended.
              </p>
            </>
          )}
        </Panel>

        <Panel
          className="lg:col-span-2 xl:col-span-1"
          title={<h2>Wall time to terminal</h2>}
          kicker="created_at → finished_at"
          actions={
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              p50 {p50 === null ? "—" : `${Math.round(p50 / 1000)}s`} · p95{" "}
              {p95 === null ? "—" : `${Math.round(p95 / 1000)}s`}
            </span>
          }
        >
          {placements.isLoading && !placements.data ? (
            <LoadingRows rows={4} />
          ) : (
            <>
              <DurationBars items={durations} />
              <p className="mt-5 border-t border-hairline pt-4 text-[11px] leading-relaxed text-muted-foreground">
                {durations.length} of {rows.length} walked placements are
                finished; percentiles are nearest-rank over exactly those
                samples.
              </p>
            </>
          )}
        </Panel>
      </div>

      {/* ------------------------ recent executions · dead letters ------------------------ */}
      <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
        <Panel
          className="lg:col-span-2"
          bodyClass="p-0"
          title={<h2>Recent executions</h2>}
          kicker="newest placements first"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/workflows">View all</Link>
            </Button>
          }
        >
          {recent.isLoading && !recent.data ? (
            <div className="p-5">
              <LoadingRows rows={5} />
            </div>
          ) : recent.isError ? (
            <div className="p-5">
              <ErrorState
                error={recent.error}
                onRetry={() => recent.refetch()}
              />
            </div>
          ) : recent.data && recent.data.items.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<Activity className="size-5" />}
                title="No workflows yet"
                hint="Create one with “New workflow” above — the engine queues it and a worker picks it up within seconds."
              />
            </div>
          ) : (
            <>
              <ul className="flex flex-col">
                {(recent.data?.items ?? []).map((w) => (
                  <li key={w.id}>
                    <Link
                      to={`/workflows/${w.id}`}
                      className="group flex items-center gap-3 border-b border-hairline px-5 py-3 transition-colors last:border-b-0 hover:bg-chip"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{
                          background: `var(--st-${workflowStatus(w.state).tone})`,
                        }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {w.def_name}{" "}
                          <span className="font-mono text-xs text-muted-foreground">
                            v{w.def_version}
                          </span>
                        </span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {w.business_key}
                        </span>
                      </span>
                      <StatusBadge state={w.state} size="sm" />
                      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                        <RelTime iso={w.created_at} />
                      </span>
                      <ArrowRight
                        className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
              {recentSplit.total > 0 && (
                <p className="border-t border-hairline px-5 py-3 text-[11px] text-muted-foreground">
                  This page: {recentSplit.completed} completed,{" "}
                  {recentSplit.negative} negative, {recentSplit.open} still
                  open. Cursor paging shows the {recent.data?.items.length}{" "}
                  newest of {total} placements.
                </p>
              )}
            </>
          )}
        </Panel>

        <Panel
          title={<h2>Dead letters</h2>}
          kicker="fathom_dlq_depth · GET /v1/dlq"
        >
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-[30px] leading-none font-bold tracking-[-0.03em] text-foreground tabular-nums">
              {dlqTotal}
            </span>
            <span className="text-xs text-muted-foreground">
              open · oldest{" "}
              {oldestDlq === null ? "—" : `${Math.round(oldestDlq / 3600)} h`}
            </span>
          </div>
          {dlqPage.isLoading && !dlqPage.data ? (
            <LoadingRows rows={3} />
          ) : dlqPage.isError ? (
            <ErrorState
              error={dlqPage.error}
              onRetry={() => dlqPage.refetch()}
            />
          ) : (dlqPage.data?.items.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing has been parked for manual intervention — the dead-letter
              table is empty.
            </p>
          ) : (
            <>
              <ul className="-mt-1 flex flex-col">
                {(dlqPage.data?.items ?? []).map((d) => (
                  <li
                    key={d.id}
                    className="border-b border-hairline last:border-b-0"
                  >
                    <Link
                      to={`/workflows/${d.workflow_id}`}
                      className="group flex items-start gap-3 py-2.5"
                    >
                      <span
                        className={`mt-1.5 size-2 shrink-0 rounded-full ${d.resolved_at ? "bg-st-completed" : "bg-st-manual"}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {d.class}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {d.reason_code}
                          {d.step_type ? ` · ${d.step_type}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-[11px] text-muted-foreground">
                        <RelTime iso={d.created_at} />
                        <span className="block">
                          {d.resolved_at ? "resolved" : "open"}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mt-3 border-t border-hairline pt-3 text-[11px] leading-relaxed text-muted-foreground">
                {dlqPage.data!.items.filter((d) => !d.resolved_at).length} open,{" "}
                {dlqPage.data!.items.filter((d) => d.resolved_at).length}{" "}
                resolved on this page. A dead letter is a step the engine
                stopped retrying — it needs an operator action on the workflow.
              </p>
            </>
          )}
          <Button
            asChild
            variant="outline"
            size="xs"
            className="mt-4 w-full shrink-0"
          >
            <Link to="/dlq">
              Open dead-letter queue
              <ArrowRight />
            </Link>
          </Button>
        </Panel>
      </div>
    </div>
  );
}
