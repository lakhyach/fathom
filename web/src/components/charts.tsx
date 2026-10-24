/* Glacier Glass data views — Phase 7 rebuild on Recharts.
   Every chart here renders ONLY parsed /metrics series or API rows; a
   missing series draws an honest empty state, never an invented curve.
   Colours come from the same --st-* state tokens the badges use, so a ring,
   a bar and a pill always tell the same story. */
import { useMemo } from "react";
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { toneVar, workflowStatus } from "../theme/status";
import { TONE, humanDuration } from "./ui";
import { cn } from "@/lib/utils";

/* ---- census donut (fathom_workflows_total) ----
   Recharts pie ring + a detailed legend that fills a tall panel honestly
   (no invented series). Centre shows the durable total; each legend row
   carries count and share of total. */

export interface CensusSlice {
  state: string;
  count: number;
}

export function Donut({ slices, total, size = 176, thickness = 24 }: {
  slices: CensusSlice[];
  total: number;
  size?: number;
  thickness?: number;
}) {
  const segs = useMemo(
    () => slices.filter((s) => s.count > 0).map((s) => ({ ...s, frac: s.count / total })),
    [slices, total],
  );

  if (total <= 0) {
    return <p className="text-xs text-muted-foreground">No workflows recorded yet — the census is empty, not zero-traffic.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <PieChart width={size} height={size}>
          <Pie
            data={segs}
            dataKey="count"
            nameKey="state"
            innerRadius={(size - thickness) / 2}
            outerRadius={size / 2}
            startAngle={90}
            endAngle={-270}
            stroke="none"
            isAnimationActive={false}
          >
            {segs.map((s) => (
              <Cell key={s.state} fill={toneVar(workflowStatus(s.state).tone)} />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) =>
              active && payload?.length ? (
                <div className="rounded-md border border-border/70 bg-popover px-2.5 py-1.5 text-xs shadow-lg">
                  <span className="font-medium">{workflowStatus(String(payload[0].name)).label}</span>
                  <span className="ml-1.5 font-mono tabular-nums">{payload[0].value}</span>
                </div>
              ) : null
            }
          />
        </PieChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-2xl leading-none font-semibold text-foreground tabular-nums">{total}</span>
          <span className="mt-1 text-[10px] tracking-[0.12em] text-muted-foreground uppercase">workflows</span>
        </div>
      </div>
      <ul className="flex min-w-36 flex-1 flex-col gap-1.5">
        {segs.map((s) => {
          const m = workflowStatus(s.state);
          return (
            <li key={s.state} className="flex items-center gap-2 text-sm">
              <span className="size-2 shrink-0 rounded-full" style={{ background: toneVar(m.tone) }} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-foreground">{m.label}</span>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{Math.round(s.frac * 100)}%</span>
              <span className="w-8 text-right font-mono text-xs text-foreground tabular-nums">{s.count}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---- horizontal bars (classification totals, DLQ by class, relay lag) ---- */

const BAR_TONE: Record<string, string> = {
  blue: "var(--st-running)",
  violet: "var(--st-compensating)",
};

export function BarList({ rows, tone = "blue", emptyText = "No samples in this series yet." }: {
  rows: Array<{ key: string; value: number; label?: string }>;
  tone?: "blue" | "violet" | "status";
  emptyText?: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (rows.length === 0 || max === 0) return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  const colorOf = (key: string) => (tone === "status" ? toneVar(workflowStatus(key).tone) : BAR_TONE[tone]);
  const data = rows.map((r) => ({ name: r.label ?? r.key, value: r.value, fill: colorOf(r.key) }));
  const height = rows.length * 34 + 24;
  return (
    <div
      role="img"
      aria-label={`Bar chart: ${rows.map((r) => `${r.label ?? r.key} ${r.value}`).join(", ")}`}
      style={{ width: "100%", height }}
    >
      <ResponsiveContainer width="100%" height={height}>
        <BarChart layout="vertical" data={data} margin={{ top: 2, right: 44, bottom: 2, left: 4 }}>
          <XAxis type="number" hide domain={[0, max]} />
          <YAxis
            type="category"
            dataKey="name"
            width={104}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <div className="rounded-md border border-border/70 bg-popover px-2.5 py-1.5 text-xs shadow-lg">
                  <span className="font-medium">{payload[0].payload?.name}</span>
                  <span className="ml-1.5 font-mono tabular-nums">{payload[0].value}</span>
                </div>
              ) : null
            }
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false} label={{ position: "right", fill: "var(--foreground)", fontSize: 11 }}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ---- gauge ring: one bounded scalar vs its threshold ---- */

export function GaugeRing({
  value,
  max,
  label,
  unitSeconds = true,
  size = 88,
}: {
  value: number | null;
  max: number;
  label: string;
  unitSeconds?: boolean;
  size?: number;
}) {
  const frac = value === null ? 0 : Math.min(1, value / Math.max(max, 1e-9));
  const hot = value !== null && value > max;
  const text = value === null ? "—" : unitSeconds ? humanDuration(value * 1000) : String(Math.round(value));
  return (
    <div className="flex flex-col items-center gap-2" role="img" aria-label={`${label}: ${text} of ${humanDuration(max * 1000)} budget`}>
      <div className="relative" style={{ width: size, height: size }}>
        <PieChart width={size} height={size}>
          <Pie
            data={[{ n: "used", v: frac * 100 }, { n: "free", v: 100 - frac * 100 }]}
            dataKey="v"
            innerRadius={size / 2 - 9}
            outerRadius={size / 2 - 2}
            startAngle={90}
            endAngle={-270}
            stroke="none"
            isAnimationActive={false}
          >
            <Cell fill={hot ? "var(--st-negative)" : "var(--primary)"} />
            <Cell fill="var(--muted)" />
          </Pie>
        </PieChart>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className={cn("font-mono text-[11.5px] font-semibold tabular-nums", hot ? "text-st-negative" : "text-foreground")}>{text}</span>
        </div>
      </div>
      <span className="max-w-32 text-center text-[11px] leading-snug text-muted-foreground">{label}</span>
    </div>
  );
}

/* ---- transition flow strip: recent from→to edges (transitions counter) ---- */

export function TransitionBars({ rows }: { rows: Array<{ from: string; to: string; count: number }> }) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No transitions recorded yet.</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.slice(0, 8).map((r) => {
        const from = workflowStatus(r.from);
        const to = workflowStatus(r.to);
        return (
          <li key={`${r.from}-${r.to}`} className="flex items-center gap-2.5 text-sm">
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs", toneChip(from.tone))}>{from.label}</span>
            <span className="text-muted-foreground" aria-hidden="true">→</span>
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs", toneChip(to.tone))}>{to.label}</span>
            <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{r.count}</span>
          </li>
        );
      })}
    </ul>
  );
}

function toneChip(tone: Parameters<typeof toneVar>[0]): string {
  return TONE[tone].badge;
}
