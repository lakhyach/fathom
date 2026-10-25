/* Phase 8.1 time-plane views — the two signature Overview graphics.
   Both are drawn from the placement rows the cursor walk returned, in the
   axis domain that `timePlane()` fitted to those rows' real timestamps, so a
   quiet fleet produces a short honest span rather than a bar in a void.
   DOM/CSS rather than a chart library: the reference's language is rounded
   capsules, per-node lighting and hairline guides, which is exactly what
   absolute positioning expresses without a hundred SVG overrides. */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";

import { cn } from "@/lib/utils";
import { toneVar, workflowStatus } from "../theme/status";
import { fmtTime, humanDuration } from "./ui";
import { useSettings } from "../state/settings";
import type { CellKind, MatrixRow, TimePlane, Track } from "../lib/aggregate";

const ROW_H = 38;

function timeText(t: number, mode: "utc" | "local"): string {
  return fmtTime(new Date(t), mode, true);
}

/** Axis labels carry only the precision the span really has: a 44-hour field
 *  never needs seconds, a 40-minute field needs them. */
function axisLabel(t: number, spanMs: number, mode: "utc" | "local"): string {
  const timeZone = mode === "utc" ? "UTC" : undefined;
  const opts: Intl.DateTimeFormatOptions =
    spanMs > 30 * 3600_000
      ? {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone,
        }
      : spanMs > 2 * 3600_000
        ? { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }
        : {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
            timeZone,
          };
  return new Intl.DateTimeFormat("en-GB", opts).format(new Date(t));
}

/* ------------------------------ execution timeline ------------------------- */

/** One capsule per placement: created → terminal (or → now while open), on a
 *  fitted axis with hairline guides. Every mark is a real ledger row. */
export function ExecutionTimeline({
  tracks,
  plane,
  now,
  limit = 7,
}: {
  tracks: Track[];
  plane: TimePlane;
  /** Captured once by the screen — a render must not read the clock itself. */
  now: number;
  limit?: number;
}) {
  const { timeFormat } = useSettings();
  const [hot, setHot] = useState<number | null>(null);
  const shown = tracks.slice(0, limit);
  const span = plane.to - plane.from || 1;
  const pos = (t: number) => ((t - plane.from) / span) * 100;
  const ticks = pickTicks(plane);
  const nowInside = now >= plane.from && now <= plane.to;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [trackW, setTrackW] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    setTrackW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setTrackW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const laid = layoutTicks(ticks, trackW || 1e9);

  return (
    <div className="relative">
      {/* axis guides + tick labels */}
      <div className="flex">
        <div className="w-[104px] shrink-0 sm:w-[132px] xl:w-[164px]" />
        <div ref={trackRef} className="relative h-6 min-w-0 flex-1">
          {laid.map((tk) => (
            <span
              key={tk.t}
              className={cn(
                "absolute font-mono text-[10px] whitespace-nowrap text-muted-foreground/80 tabular-nums",
                tk.hide && "hidden",
                tk.align === "left"
                  ? "translate-x-0"
                  : tk.align === "right"
                    ? "-translate-x-full"
                    : "-translate-x-1/2",
              )}
              style={{
                left: `${tk.align === "left" ? 0 : tk.align === "right" ? 100 : pos(tk.t)}%`,
              }}
            >
              {axisLabel(tk.t, span, timeFormat)}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col">
        {shown.map((tr, i) => {
          const meta = workflowStatus(tr.state);
          const tone = toneVar(meta.tone);
          const left = Math.max(0, pos(tr.created));
          const right = Math.min(100, pos(tr.end));
          const width = Math.max(0.9, right - left);
          const active = hot === i;
          return (
            <div
              key={tr.id}
              className="flex items-center"
              style={{ height: ROW_H }}
            >
              <div className="w-[104px] shrink-0 pr-2 sm:w-[132px] sm:pr-3 xl:w-[164px]">
                <Link
                  to={`/workflows/${tr.id}`}
                  className="block truncate text-xs font-medium text-foreground hover:text-primary focus-visible:text-primary"
                  title={`${tr.def} · ${tr.key}`}
                >
                  {tr.def}
                </Link>
                <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                  {tr.key}
                </span>
              </div>
              <div
                className="relative h-full min-w-0 flex-1 rounded-lg bg-canvas/50"
                onMouseEnter={() => setHot(i)}
                onMouseLeave={() => setHot((h) => (h === i ? null : h))}
              >
                {ticks.map((tk) => (
                  <span
                    key={tk.t}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-1 w-px bg-hairline"
                    style={{ left: `${pos(tk.t)}%` }}
                  />
                ))}
                <motion.div
                  initial={{ opacity: 0, scaleX: 0.6 }}
                  animate={{ opacity: 1, scaleX: 1 }}
                  transition={{
                    delay: i * 0.045,
                    duration: 0.42,
                    ease: [0.22, 0.61, 0.21, 1],
                  }}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    transformOrigin: "left center",
                    background: `linear-gradient(90deg, color-mix(in oklab, ${tone} 34%, transparent), ${tone})`,
                    boxShadow: `0 0 18px -6px ${tone}, inset 0 1px 0 oklch(1 0 0 / 22%)`,
                  }}
                  className="absolute inset-y-0 my-auto h-[13px] rounded-full"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1/2 size-[9px] -translate-y-1/2 rounded-full ring-2 ring-card transition-opacity",
                    active ? "opacity-100" : "opacity-70",
                  )}
                  style={{
                    left: `calc(${Math.min(99.4, left + width)}% - 4px)`,
                    background: tone,
                  }}
                />
                {width < 7 && (
                  <span
                    className="absolute top-1/2 -translate-y-1/2 font-mono text-[10px] whitespace-nowrap text-muted-foreground tabular-nums"
                    style={{
                      left: `calc(${Math.min(96, left + width)}% + 10px)`,
                    }}
                  >
                    {tr.open ? "open · " : ""}
                    {humanDuration(Math.max(0, tr.end - tr.created))}
                  </span>
                )}
                {tr.before && (
                  <span
                    aria-hidden="true"
                    className="absolute top-1/2 left-0 -translate-y-1/2 font-mono text-[10px] text-muted-foreground"
                    title="Placed before this axis began"
                  >
                    ◂
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {nowInside && (
          <div className="flex">
            <div className="w-[104px] shrink-0 sm:w-[132px] xl:w-[164px]" />
            <div className="relative h-5 min-w-0 flex-1">
              <span
                className="absolute top-0 h-3 w-px bg-primary/70"
                style={{ left: `${pos(now)}%` }}
                aria-hidden="true"
              />
              <span
                className="absolute top-3 -translate-x-1/2 text-[10px] font-semibold text-primary"
                style={{ left: `${pos(now)}%` }}
              >
                now
              </span>
            </div>
          </div>
        )}
      </div>

      {hot !== null && shown[hot] && (
        <TimelineTip track={shown[hot]} plane={plane} />
      )}
    </div>
  );
}

function TimelineTip({ track, plane }: { track: Track; plane: TimePlane }) {
  const { timeFormat } = useSettings();
  const meta = workflowStatus(track.state);
  return (
    <div className="pointer-events-none absolute top-8 right-0 z-20 w-64 rounded-xl border border-border/70 bg-popover p-3 text-xs shadow-[var(--shadow-lift)]">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold text-foreground">
          {track.def}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {meta.label}
        </span>
      </div>
      <dl className="mt-2 space-y-1 font-mono text-[11px] tabular-nums">
        <Row k="placed" v={timeText(track.created, timeFormat)} />
        <Row k="last change" v={timeText(track.updated, timeFormat)} />
        <Row
          k="terminal"
          v={track.open ? "still open" : timeText(track.end, timeFormat)}
        />
        <Row
          k="wall time"
          v={humanDuration(Math.max(0, track.end - track.created))}
        />
      </dl>
      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        {track.open
          ? "Open rows extend to the snapshot moment."
          : "Bar spans created_at to finished_at."}
      </p>
      <span className="sr-only">
        Axis spans {plane.spanMs / 3600000} hours.
      </span>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-foreground">{v}</dd>
    </div>
  );
}

function pickTicks(plane: TimePlane): Array<{ t: number }> {
  // Date-carrying labels are wide: a multi-day axis gets fewer guides so they
  // never run into each other.
  const n = plane.spanMs > 30 * 3600_000 ? 4 : 6;
  return Array.from({ length: n + 1 }, (_, i) => ({
    t: plane.from + ((plane.to - plane.from) * i) / n,
  }));
}

/** A guide is free; a label is only legible if it does not touch its neighbour.
 *  Measured against the real track width, so the same axis thins itself on a
 *  narrow panel instead of overprinting (the Phase 8 defect). */
function layoutTicks(
  ticks: Array<{ t: number }>,
  trackW: number,
  labelW = 82,
): Array<{ t: number; hide: boolean; align: "left" | "right" | "center" }> {
  const last = ticks.length - 1;
  const kept: Array<{ l: number; r: number; i: number }> = [];
  ticks.forEach((_, i) => {
    const c = (i / last) * trackW;
    let l = c - labelW / 2;
    let r = c + labelW / 2;
    if (i === 0) [l, r] = [0, labelW];
    if (i === last) [l, r] = [trackW - labelW, trackW];
    const prev = kept[kept.length - 1];
    if (prev && l < prev.r + 6) {
      // an end label is worth more than an interior one
      if (i === last) kept[kept.length - 1] = { l, r, i };
      return;
    }
    kept.push({ l, r, i });
  });
  const keep = new Set(kept.map((k) => k.i));
  return ticks.map((tk, i) => ({
    ...tk,
    hide: !keep.has(i),
    align: i === 0 ? "left" : i === last ? "right" : "center",
  }));
}

/* -------------------------------- activity matrix --------------------------- */

const CELL: Record<
  CellKind,
  { label: string; className: string; dot: string }
> = {
  none: {
    label: "not placed yet",
    className: "text-muted-foreground/50",
    dot: "bg-foreground/8",
  },
  placed: {
    label: "placed in this slot",
    className: "text-foreground",
    dot: "bg-primary shadow-[0_0_10px_-1px_oklch(0.735_0.174_140/80%)]",
  },
  inflight: {
    label: "in flight",
    className: "text-foreground",
    dot: "bg-st-running/70",
  },
  progressed: {
    label: "ledger row changed",
    className: "text-foreground",
    dot: "bg-st-compensating",
  },
  completed: {
    label: "reached a terminal success",
    className: "text-foreground",
    dot: "bg-st-completed shadow-[0_0_10px_-2px_oklch(0.79_0.165_145/70%)]",
  },
  negative: {
    label: "failed or aborted",
    className: "text-foreground",
    dot: "bg-st-negative shadow-[0_0_10px_-2px_oklch(0.735_0.165_22/70%)]",
  },
  manual: {
    label: "needs manual attention",
    className: "text-foreground",
    dot: "bg-st-manual shadow-[0_0_10px_-2px_oklch(0.76_0.17_335/70%)]",
  },
  settled: {
    label: "settled — no change since",
    className: "text-muted-foreground",
    dot: "bg-transparent ring-1 ring-inset ring-border/80",
  },
  uncovered: {
    label: "not covered by the cursor walk",
    className: "text-st-warn",
    dot: "bg-[repeating-linear-gradient(45deg,oklch(0.845_0.155_85/28%)_0_3px,transparent_3px_6px)]",
  },
};

/** Placements × time slots. Reads as the reference's dot field, but each cell
 *  states one fact the ledger really holds for that workflow in that slot. */
export function ActivityMatrix({
  rows,
  plane,
  covered,
}: {
  rows: MatrixRow[];
  plane: TimePlane;
  covered: boolean;
}) {
  const { timeFormat } = useSettings();
  const [hot, setHot] = useState<{ r: number; c: number } | null>(null);
  if (rows.length === 0) return null;
  const cols = rows[0].cells.length;
  const hotCell =
    hot && rows[hot.r]
      ? { row: rows[hot.r], cell: rows[hot.r].cells[hot.c] }
      : null;

  return (
    <div className="relative">
      <div className="flex">
        <div className="w-[92px] shrink-0 sm:w-[124px] xl:w-[152px]" />
        <div className="@container flex min-w-0 flex-1 justify-between font-mono text-[10px] text-muted-foreground/70">
          <span>{axisLabel(plane.from, plane.spanMs, timeFormat)}</span>
          <span className="hidden @[22rem]:inline">
            {axisLabel((plane.from + plane.to) / 2, plane.spanMs, timeFormat)}
          </span>
          <span>{axisLabel(plane.to, plane.spanMs, timeFormat)}</span>
        </div>
      </div>
      <ul className="mt-2 flex flex-col gap-2">
        {rows.map((row, r) => (
          <li key={row.id} className="flex items-center">
            <div className="w-[92px] shrink-0 pr-2 sm:w-[124px] sm:pr-3 xl:w-[152px]">
              <span
                className="block truncate text-xs text-foreground"
                title={`${row.def} · ${row.key}`}
              >
                {row.def}
              </span>
            </div>
            <div
              className="grid min-w-0 flex-1 gap-[5px]"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {row.cells.map((cell, c) => {
                const held =
                  cell.kind === "inflight" &&
                  row.cells[c - 1]?.kind === "inflight" &&
                  row.cells[c + 1]?.kind === "inflight";
                return (
                  <button
                    key={c}
                    type="button"
                    aria-label={`${row.def} ${workflowStatus(cell.state ?? row.state).label} — ${CELL[cell.kind].label}`}
                    onMouseEnter={() => setHot({ r, c })}
                    onMouseLeave={() =>
                      setHot((h) => (h?.r === r && h?.c === c ? null : h))
                    }
                    onFocus={() => setHot({ r, c })}
                    onBlur={() => setHot(null)}
                    className={cn(
                      "aspect-square w-full max-w-3.5 rounded-full outline-none transition-transform duration-150",
                      CELL[cell.kind].dot,
                      held && "opacity-35",
                      "hover:scale-125 focus-visible:scale-125 focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                    style={{
                      animation: `matrixIn .4s ${Math.min(0.5, c * 0.012 + r * 0.03)}s backwards`,
                    }}
                  />
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      {hotCell && (
        <div className="pointer-events-none absolute -top-1 right-0 z-20 w-60 rounded-xl border border-border/70 bg-popover px-3 py-2 text-[11px] shadow-[var(--shadow-lift)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-semibold text-foreground">
              {hotCell.row.def}
            </span>
            <span className="font-mono text-muted-foreground tabular-nums">
              {timeText(hotCell.cell.from, timeFormat)}
            </span>
          </div>
          <p className={cn("mt-1", CELL[hotCell.cell.kind].className)}>
            {CELL[hotCell.cell.kind].label}
          </p>
          <p className="mt-1 font-mono text-muted-foreground">
            {covered ? "" : "walk depth capped · "}
            {hotCell.row.key}
          </p>
          <Link
            to={`/workflows/${hotCell.row.id}`}
            className="pointer-events-auto mt-1.5 inline-block text-primary hover:underline"
          >
            Open inspector →
          </Link>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- KPI visuals ----------------------------- */

/** Stacked composition of a real census — a proportion, never a fake trend. */
export function SpectrumBar({
  segments,
}: {
  segments: Array<{ label: string; value: number; tone: string }>;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-3 overflow-hidden rounded-full bg-chip"
        role="img"
        aria-label={segments.map((s) => `${s.label} ${s.value}`).join(", ")}
      >
        {total > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <span
                key={s.label}
                title={`${s.label}: ${s.value}`}
                className="h-full"
                style={{
                  width: `${(s.value / total) * 100}%`,
                  background: `linear-gradient(180deg, ${s.tone}, color-mix(in oklab, ${s.tone} 62%, black))`,
                }}
              />
            ))}
      </div>
      <ul className="flex w-full min-w-0 flex-col gap-1">
        {segments
          .filter((s) => s.value > 0)
          .slice(0, 3)
          .map((s) => (
            <li
              key={s.label}
              className="flex w-full min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground"
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: s.tone }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="shrink-0 font-mono text-foreground tabular-nums">
                {s.value}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Real completed/terminal share as a lit ring. Empty when nothing finished. */
export function ProgressRing({
  value,
  caption,
  tone = "var(--st-completed)",
  size = 74,
}: {
  value: number | null;
  caption: string;
  tone?: string;
  size?: number;
}) {
  const r = size / 2 - 6;
  const circ = 2 * Math.PI * r;
  const frac = value === null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <defs>
          <linearGradient id="kpi-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--lime-bright)" />
            <stop offset="100%" stopColor={tone} />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--chip)"
          strokeWidth="7"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="url(#kpi-ring)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${frac * circ} ${circ}`}
          style={{ transition: "stroke-dasharray .6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-[15px] leading-none font-semibold text-foreground tabular-nums">
          {value === null ? "—" : `${Math.round(frac * 100)}`}
          {value === null ? "" : <span className="text-[10px]">%</span>}
        </span>
        <span className="mt-1 max-w-[62px] text-center text-[9px] leading-tight text-muted-foreground">
          {caption}
        </span>
      </div>
    </div>
  );
}

/** The engine's own pipeline: one node per live state, sized by real count. */
export function NodeMotif({
  nodes,
}: {
  nodes: Array<{ label: string; value: number; tone: string }>;
}) {
  const w = 96;
  const h = 62;
  const pts = nodes.slice(0, 5).map((n, i, arr) => ({
    ...n,
    x: 10 + (i * (w - 20)) / Math.max(1, arr.length - 1),
    y: i % 2 === 0 ? 14 : h - 14,
  }));
  const any = pts.some((p) => p.value > 0);
  if (!any) {
    /* Nothing live is a fact worth drawing — an idle rail, not a faint ghost. */
    return (
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label="No steps are currently held by a worker"
      >
        <line
          x1="8"
          y1={h / 2}
          x2={w - 8}
          y2={h / 2}
          stroke="var(--muted-foreground)"
          strokeOpacity="0.45"
          strokeWidth="1.2"
          strokeDasharray="4 5"
        />
        {pts.map((p) => (
          <circle
            key={p.label}
            cx={p.x}
            cy={h / 2}
            r="4"
            fill="var(--canvas)"
            stroke="var(--muted-foreground)"
            strokeOpacity="0.55"
            strokeWidth="1.3"
          />
        ))}
      </svg>
    );
  }
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {pts.slice(1).map((p, i) => (
        <line
          key={i}
          x1={pts[i].x}
          y1={pts[i].y}
          x2={p.x}
          y2={p.y}
          stroke="var(--border)"
          strokeWidth="1.2"
          strokeDasharray="3 3"
        />
      ))}
      {pts.map((p) => (
        <g key={p.label}>
          <circle
            cx={p.x}
            cy={p.y}
            r={3 + Math.min(7, p.value * 1.6)}
            fill={p.value > 0 ? p.tone : "var(--chip)"}
            opacity={p.value > 0 ? 0.9 : 0.55}
          />
          <circle
            cx={p.x}
            cy={p.y}
            r={3 + Math.min(7, p.value * 1.6)}
            fill="none"
            stroke={p.value > 0 ? p.tone : "var(--border)"}
            strokeWidth="1"
            opacity="0.45"
          />
          <title>{`${p.label}: ${p.value}`}</title>
        </g>
      ))}
    </svg>
  );
}

/** Ranked thin bars — used for outcome splits and per-definition volume. */
export function MiniSplit({
  rows,
  showLabel = true,
}: {
  rows: Array<{ label: string; value: number; tone: string }>;
  showLabel?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex w-full flex-col gap-1.5">
      {rows.map((r) => (
        <li key={r.label} className="flex items-center gap-2">
          {showLabel && (
            <span className="w-14 shrink-0 truncate text-[10px] text-muted-foreground">
              {r.label}
            </span>
          )}
          <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-chip">
            <span
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
              style={{
                width: `${(r.value / max) * 100}%`,
                background: `linear-gradient(90deg, color-mix(in oklab, ${r.tone} 55%, transparent), ${r.tone})`,
              }}
            />
          </span>
          <span className="w-6 shrink-0 text-right font-mono text-[10px] text-foreground tabular-nums">
            {r.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Queue depth as real bars per dead-letter class, plus the outbox backlog. */
export function QueueBars({
  columns,
}: {
  columns: Array<{ label: string; value: number; tone: string }>;
}) {
  const max = Math.max(1, ...columns.map((c) => c.value));
  return (
    <div className="flex h-[62px] w-full items-end gap-1.5">
      {columns.map((c) => (
        <div
          key={c.label}
          className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
        >
          <div className="flex h-9 w-4 items-end overflow-hidden rounded-[5px] bg-chip ring-1 ring-border/70 ring-inset">
            <motion.span
              initial={{ height: 0 }}
              animate={{ height: `${(c.value / max) * 100}%` }}
              transition={{ duration: 0.5, ease: [0.22, 0.61, 0.21, 1] }}
              className="w-full rounded-[5px]"
              style={{
                background: `linear-gradient(180deg, ${c.tone}, color-mix(in oklab, ${c.tone} 55%, black))`,
              }}
              title={`${c.label}: ${c.value}`}
            />
          </div>
          <span className="w-full truncate text-center text-[9px] text-muted-foreground">
            {c.label}
          </span>
        </div>
      ))}
    </div>
  );
}
