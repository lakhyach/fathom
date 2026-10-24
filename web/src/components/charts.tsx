/* Verdant Frame data views — Phase 8. Recharts primitives tuned to the
   reference's chart language: gradient-filled rounded bars, a ring with
   separated arcs, hairline grid, and tooltips that use the same popover
   surface as the rest of the system.
   Honesty rule unchanged from Phase 7: every chart here renders only parsed
   /metrics series or real API rows. A missing series draws an empty state —
   never an invented curve, never a zero that means "unknown".
   Colours come from the same --st-* tokens the badges use, so a ring, a bar
   and a pill always tell the same story. */
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { toneVar, workflowStatus } from "../theme/status";
import { TONE, humanDuration } from "./ui";
import type { Duration } from "../lib/aggregate";
import { cn } from "@/lib/utils";

/* ---------------------------- shared fragments ---------------------------- */

const TIP_CLASS =
  "rounded-xl border border-border/70 bg-popover px-3 py-2 text-xs shadow-[var(--shadow-lift)]";

export function ChartLegend({
  items,
}: {
  items: Array<{ label: string; value?: number | string; tone: string }>;
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {items.map((i) => (
        <li
          key={i.label}
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <span
            className="size-2 rounded-full"
            style={{ background: i.tone }}
            aria-hidden="true"
          />
          <span className="text-foreground">{i.label}</span>
          {i.value !== undefined && (
            <span className="font-mono tabular-nums">{i.value}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------- placement trend chart ------------------------- */

export interface TrendPoint {
  t: number;
  label: string;
  completed: number;
  negative: number;
  open: number;
  total: number;
}

/** Stacked placement volume per bucket, split by outcome. Fed exclusively by
 *  rows the cursor walk actually returned. `fill` lets the chart grow into a
 *  stretched panel instead of leaving dead space under a fixed-height plot. */
export function TrendChart({
  points,
  height = 268,
  fill = false,
}: {
  points: TrendPoint[];
  height?: number;
  fill?: boolean;
}) {
  const aria = `Placements per bucket: ${points.map((p) => `${p.label} ${p.total}`).join(", ")}`;
  return (
    <div
      className={fill ? "min-h-[220px] flex-1" : undefined}
      style={fill ? { width: "100%" } : { width: "100%", height }}
      role="img"
      aria-label={aria}
    >
      <ResponsiveContainer width="100%" height={fill ? "100%" : height}>
        <BarChart
          data={points}
          margin={{ top: 10, right: 6, bottom: 0, left: -22 }}
          barCategoryGap="24%"
        >
          <defs>
            <linearGradient id="trend-completed" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--st-completed)"
                stopOpacity={1}
              />
              <stop
                offset="100%"
                stopColor="var(--st-completed)"
                stopOpacity={0.42}
              />
            </linearGradient>
            <linearGradient id="trend-negative" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--st-negative)"
                stopOpacity={1}
              />
              <stop
                offset="100%"
                stopColor="var(--st-negative)"
                stopOpacity={0.42}
              />
            </linearGradient>
            <linearGradient id="trend-open" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--st-running)" stopOpacity={1} />
              <stop
                offset="100%"
                stopColor="var(--st-running)"
                stopOpacity={0.42}
              />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--hairline)" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            minTickGap={10}
            interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={40}
            allowDecimals={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <Tooltip
            cursor={{ fill: "var(--chip)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as TrendPoint;
              return (
                <div className={TIP_CLASS}>
                  <span className="block font-mono text-[11px] text-muted-foreground">
                    {p.label}
                  </span>
                  <span className="mt-1.5 flex items-center gap-2">
                    <span className="font-semibold text-foreground tabular-nums">
                      {p.total}
                    </span>
                    <span className="text-muted-foreground">
                      placement{p.total === 1 ? "" : "s"}
                    </span>
                  </span>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {(
                      [
                        {
                          tone: "completed",
                          label: "Completed",
                          v: p.completed,
                        },
                        {
                          tone: "negative",
                          label: "Failed / aborted",
                          v: p.negative,
                        },
                        { tone: "running", label: "Still open", v: p.open },
                      ] as const
                    )
                      .filter((r) => r.v > 0)
                      .map((r) => (
                        <li key={r.tone} className="flex items-center gap-2">
                          <span
                            className="size-1.5 rounded-full"
                            style={{ background: toneVar(r.tone) }}
                            aria-hidden="true"
                          />
                          <span className="text-muted-foreground">
                            {r.label}
                          </span>
                          <span className="ml-auto font-mono text-foreground tabular-nums">
                            {r.v}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              );
            }}
          />
          <Bar
            dataKey="completed"
            stackId="o"
            fill="url(#trend-completed)"
            maxBarSize={30}
            animationDuration={420}
          />
          <Bar
            dataKey="negative"
            stackId="o"
            fill="url(#trend-negative)"
            maxBarSize={30}
            animationDuration={420}
          />
          <Bar
            dataKey="open"
            stackId="o"
            fill="url(#trend-open)"
            maxBarSize={30}
            radius={[6, 6, 0, 0]}
            animationDuration={420}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------ census donut ------------------------------ */

export interface CensusSlice {
  state: string;
  count: number;
}

/** Ring of the durable state census. The legend carries count, share and a
 *  proportional bar, so a tall panel is filled with data rather than space. */
export function Donut({
  slices,
  total,
  size = 188,
  thickness = 26,
}: {
  slices: CensusSlice[];
  total: number;
  size?: number;
  thickness?: number;
}) {
  const segs = useMemo(
    () =>
      slices
        .filter((s) => s.count > 0)
        .map((s) => ({ ...s, frac: s.count / total })),
    [slices, total],
  );

  if (total <= 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No workflows recorded yet — the census is empty, not zero-traffic.
      </p>
    );
  }

  return (
    <div className="@container w-full">
      <div className="flex flex-col items-center gap-6 @[21rem]:flex-row @[21rem]:items-center @[21rem]:gap-7">
        <div
          className="relative shrink-0"
          style={{ width: size, height: size }}
        >
          <PieChart width={size} height={size}>
            <Pie
              data={segs}
              dataKey="count"
              nameKey="state"
              innerRadius={(size - thickness) / 2}
              outerRadius={size / 2}
              startAngle={90}
              endAngle={-270}
              paddingAngle={2}
              cornerRadius={6}
              stroke="none"
              animationDuration={480}
            >
              {segs.map((s) => (
                <Cell
                  key={s.state}
                  fill={toneVar(workflowStatus(s.state).tone)}
                />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const s = payload[0].payload as {
                  state: string;
                  count: number;
                };
                return (
                  <div className={TIP_CLASS}>
                    <span className="font-medium">
                      {workflowStatus(s.state).label}
                    </span>
                    <span className="ml-2 font-mono text-foreground tabular-nums">
                      {s.count}
                    </span>
                  </div>
                );
              }}
            />
          </PieChart>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[30px] leading-none font-bold tracking-[-0.03em] text-foreground tabular-nums">
              {total}
            </span>
            <span className="mt-1.5 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              workflows
            </span>
          </div>
        </div>
        <ul className="flex w-full min-w-0 flex-1 flex-col gap-2.5">
          {segs.map((s) => {
            const m = workflowStatus(s.state);
            return (
              <li key={s.state} className="flex flex-col gap-1.5">
                <div className="flex items-start gap-2 text-sm">
                  <span
                    className="mt-1.5 size-2 shrink-0 rounded-full"
                    style={{ background: toneVar(m.tone) }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 text-foreground">
                    {m.label}
                  </span>
                  <span className="shrink-0 font-mono text-sm text-foreground tabular-nums">
                    {s.count}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-chip">
                    <div
                      className="h-full rounded-full transition-[width] duration-500 ease-out"
                      style={{
                        width: `${Math.max(2, s.frac * 100)}%`,
                        background: toneVar(m.tone),
                      }}
                      aria-hidden="true"
                    />
                  </div>
                  <span className="w-9 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                    {Math.round(s.frac * 100)}%
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/* --------------------------- horizontal bar lists ------------------------- */

const BAR_TONE: Record<string, string> = {
  lime: "var(--primary)",
  teal: "var(--st-running)",
  violet: "var(--st-compensating)",
  magenta: "var(--st-manual)",
  amber: "var(--st-warn)",
};

export function BarList({
  rows,
  tone = "lime",
  emptyText = "No samples in this series yet.",
}: {
  rows: Array<{ key: string; value: number; label?: string }>;
  tone?: keyof typeof BAR_TONE | "status";
  emptyText?: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (rows.length === 0 || max === 0)
    return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  const colorOf = (key: string) =>
    tone === "status" ? toneVar(workflowStatus(key).tone) : BAR_TONE[tone];
  const data = rows.map((r) => ({
    name: r.label ?? r.key,
    value: r.value,
    fill: colorOf(r.key),
  }));
  const height = rows.length * 36 + 24;
  return (
    <div
      role="img"
      aria-label={`Bar chart: ${rows.map((r) => `${r.label ?? r.key} ${r.value}`).join(", ")}`}
      style={{ width: "100%", height }}
    >
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          layout="vertical"
          data={data}
          margin={{ top: 2, right: 40, bottom: 2, left: 4 }}
        >
          <XAxis type="number" hide domain={[0, max]} />
          <YAxis
            type="category"
            dataKey="name"
            width={112}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <Tooltip
            cursor={{ fill: "var(--chip)" }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <div className={TIP_CLASS}>
                  <span className="font-medium">
                    {payload[0].payload?.name}
                  </span>
                  <span className="ml-2 font-mono text-foreground tabular-nums">
                    {payload[0].value}
                  </span>
                </div>
              ) : null
            }
          />
          <Bar
            dataKey="value"
            radius={[0, 6, 6, 0]}
            barSize={16}
            animationDuration={420}
            label={{
              position: "right",
              fill: "var(--foreground)",
              fontSize: 11,
            }}
          >
            {data.map((d, i) => (
              <Cell key={i} fill={d.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* --------------------------- duration distribution ------------------------ */

/** Per-execution wall time as a ranked list of proportional bars, with the
 *  p50 / p95 / max summary computed from the same sample it displays. */
export function DurationBars({
  items,
  limit = 7,
}: {
  items: Duration[];
  limit?: number;
}) {
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No execution has reached a terminal state yet, so no duration is
        measurable.
      </p>
    );
  }
  const shown = items.slice(0, limit);
  const max = Math.max(...shown.map((i) => i.ms));
  return (
    <ul className="flex flex-col gap-2.5">
      {shown.map((d) => {
        const m = workflowStatus(d.state);
        return (
          <li key={d.id} className="flex items-center gap-3">
            <span
              className="w-40 min-w-0 shrink-0 truncate text-xs text-foreground"
              title={d.label}
            >
              {d.label}
            </span>
            <span className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-chip">
              <span
                className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
                style={{
                  width: `${Math.max(3, (d.ms / max) * 100)}%`,
                  background: toneVar(m.tone),
                }}
                aria-hidden="true"
              />
            </span>
            <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
              {humanDuration(d.ms)}
            </span>
          </li>
        );
      })}
      {items.length > shown.length && (
        <li className="pt-0.5 text-[11px] text-muted-foreground">
          {items.length - shown.length} further terminal execution
          {items.length - shown.length === 1 ? "" : "s"} not shown.
        </li>
      )}
    </ul>
  );
}

/* --------------------------- definition ledger ---------------------------- */

/** Ranked per-definition volumes, each bar split by outcome. Bar length is
 *  relative to the busiest definition; segments are relative to that row. */
export function MixBars({
  rows,
}: {
  rows: Array<{
    name: string;
    total: number;
    completed: number;
    negative: number;
    open: number;
  }>;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No definition has produced a placement yet.
      </p>
    );
  }
  const max = Math.max(...rows.map((r) => r.total));
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => (
        <li key={r.name} className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <span
              className="min-w-0 flex-1 truncate text-sm text-foreground"
              title={r.name}
            >
              {r.name}
            </span>
            <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
              {r.completed}/{r.total} ok
            </span>
            <span className="w-8 shrink-0 border-l border-hairline pl-3 text-right font-mono text-sm text-foreground tabular-nums">
              {r.total}
            </span>
          </div>
          <div
            className="flex h-2 overflow-hidden rounded-full"
            style={{ width: `${Math.max(4, (r.total / max) * 100)}%` }}
            role="img"
            aria-label={`${r.name}: ${r.total} workflows — ${r.completed} completed, ${r.negative} failed or aborted, ${r.open} open`}
          >
            {r.completed > 0 && (
              <span
                className="h-full"
                style={{
                  width: `${(r.completed / r.total) * 100}%`,
                  background: "var(--st-completed)",
                }}
                aria-hidden="true"
              />
            )}
            {r.negative > 0 && (
              <span
                className="h-full"
                style={{
                  width: `${(r.negative / r.total) * 100}%`,
                  background: "var(--st-negative)",
                }}
                aria-hidden="true"
              />
            )}
            {r.open > 0 && (
              <span
                className="h-full"
                style={{
                  width: `${(r.open / r.total) * 100}%`,
                  background: "var(--st-running)",
                }}
                aria-hidden="true"
              />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------ gauge ring -------------------------------- */

export function GaugeRing({
  value,
  max,
  label,
  unitSeconds = true,
  size = 92,
}: {
  value: number | null;
  max: number;
  label: string;
  unitSeconds?: boolean;
  size?: number;
}) {
  const frac = value === null ? 0 : Math.min(1, value / Math.max(max, 1e-9));
  const hot = value !== null && value > max;
  const text =
    value === null
      ? "—"
      : unitSeconds
        ? humanDuration(value * 1000)
        : String(Math.round(value));
  return (
    <div
      className="flex flex-col items-center gap-2"
      role="img"
      aria-label={`${label}: ${text} of ${humanDuration(max * 1000)} budget`}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <PieChart width={size} height={size}>
          <Pie
            data={[
              { n: "used", v: frac * 100 },
              { n: "free", v: 100 - frac * 100 },
            ]}
            dataKey="v"
            innerRadius={size / 2 - 10}
            outerRadius={size / 2 - 2}
            startAngle={90}
            endAngle={-270}
            cornerRadius={5}
            stroke="none"
            animationDuration={480}
          >
            <Cell fill={hot ? "var(--st-negative)" : "var(--primary)"} />
            <Cell fill="var(--chip)" />
          </Pie>
        </PieChart>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span
            className={cn(
              "font-mono text-xs font-semibold tabular-nums",
              hot ? "text-st-negative" : "text-foreground",
            )}
          >
            {text}
          </span>
        </div>
      </div>
      <span className="max-w-32 text-center text-[11px] leading-snug text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/* --------------------------- transition flow strip ------------------------ */

export function TransitionBars({
  rows,
}: {
  rows: Array<{ from: string; to: string; count: number }>;
}) {
  if (rows.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No transitions recorded yet.
      </p>
    );
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.slice(0, 8).map((r) => {
        const from = workflowStatus(r.from);
        const to = workflowStatus(r.to);
        return (
          <li
            key={`${r.from}-${r.to}`}
            className="flex items-center gap-2.5 text-sm"
          >
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
                TONE[from.tone].badge,
              )}
            >
              {from.label}
            </span>
            <span className="text-muted-foreground" aria-hidden="true">
              →
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
                TONE[to.tone].badge,
              )}
            >
              {to.label}
            </span>
            <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
              {r.count}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
