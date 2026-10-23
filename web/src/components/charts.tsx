/* Hand-built SVG data views — exact premium styling, zero bundle debt.
   Every chart here renders ONLY parsed /metrics series or API rows; a
   missing series draws an honest empty state, never an invented curve. */
import { useMemo } from "react";

import { workflowStatus } from "../theme/status";
import { humanDuration } from "./ui";
import "./charts.css";

/* ---- state census: stacked bar + legend (fathom_workflows_total) ---- */

export interface CensusSlice {
  state: string;
  count: number;
}

export function StateStack({ slices, total }: { slices: CensusSlice[]; total: number }) {
  const segs = useMemo(() => {
    if (total <= 0) return [];
    let acc = 0;
    return slices
      .filter((s) => s.count > 0)
      .map((s) => {
        const from = acc / total;
        acc += s.count;
        return { ...s, from, to: acc / total };
      });
  }, [slices, total]);

  if (total <= 0) {
    return <p className="fx-chart-empty">No workflows recorded yet — the census is empty, not zero-traffic.</p>;
  }
  return (
    <div className="fx-stack">
      <div className="fx-stack__bar" role="img" aria-label={`Workflow states: ${slices.map((s) => `${s.count} ${s.state}`).join(", ")}`}>
        {segs.map((s) => (
          <span
            key={s.state}
            className={`fx-stack__seg fx-stack__seg--${workflowStatus(s.state).tone}`}
            style={{ width: `${(s.to - s.from) * 100}%` }}
            title={`${s.count} ${workflowStatus(s.state).label}`}
          />
        ))}
      </div>
      <ul className="fx-stack__legend">
        {slices
          .filter((s) => s.count > 0)
          .map((s) => (
            <li key={s.state}>
              <span className={`fx-dot fx-dot--${workflowStatus(s.state).tone}`} aria-hidden="true" />
              <span className="fx-stack__label">{workflowStatus(s.state).label}</span>
              <span className="fx-stack__count num">{s.count}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/* ---- census donut: same real data as StateStack, but a ring + a detailed
   legend that fills a tall panel honestly (no invented series). Centre shows
   the durable total; each legend row carries count and share of total. ---- */

export function Donut({ slices, total, size = 176, thickness = 24 }: {
  slices: CensusSlice[];
  total: number;
  size?: number;
  thickness?: number;
}) {
  const segs = useMemo(() => {
    if (total <= 0) return [];
    let acc = 0;
    return slices
      .filter((s) => s.count > 0)
      .map((s) => {
        const from = acc / total;
        acc += s.count;
        return { ...s, from, frac: s.count / total };
      });
  }, [slices, total]);

  if (total <= 0) {
    return <p className="fx-chart-empty">No workflows recorded yet — the census is empty, not zero-traffic.</p>;
  }

  const cx = size / 2;
  const R = (size - thickness) / 2;
  const C = 2 * Math.PI * R;

  return (
    <div className="fx-donut">
      <svg
        className="fx-donut__chart"
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label={`Workflow state census, ${total} total: ${segs.map((s) => `${s.count} ${workflowStatus(s.state).label}`).join(", ")}`}
      >
        <circle cx={cx} cy={cx} r={R} fill="none" stroke="var(--fx-inset)" strokeWidth={thickness} />
        <g transform={`rotate(-90 ${cx} ${cx})`}>
          {segs.map((s) => (
            <circle
              key={s.state}
              cx={cx}
              cy={cx}
              r={R}
              fill="none"
              stroke={`var(--fx-st-${workflowStatus(s.state).tone})`}
              strokeWidth={thickness}
              strokeDasharray={`${s.frac * C} ${C - s.frac * C}`}
              strokeDashoffset={-s.from * C}
              className={`fx-donut__seg fx-donut__seg--${workflowStatus(s.state).tone}`}
            >
              <title>{`${s.count} ${workflowStatus(s.state).label}`}</title>
            </circle>
          ))}
        </g>
        <text x={cx} y={cx - 3} textAnchor="middle" className="fx-donut__total num">{total}</text>
        <text x={cx} y={cx + 16} textAnchor="middle" className="fx-donut__cap">workflows</text>
      </svg>
      <ul className="fx-donut__legend">
        {segs.map((s) => (
          <li key={s.state}>
            <span className={`fx-dot fx-dot--${workflowStatus(s.state).tone}`} aria-hidden="true" />
            <span className="fx-donut__label">{workflowStatus(s.state).label}</span>
            <span className="fx-donut__pct num">{Math.round(s.frac * 100)}%</span>
            <span className="fx-donut__count num">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---- horizontal bars (classification totals, DLQ by class) ---- */

export function BarList({ rows, tone = "blue", emptyText = "No samples in this series yet." }: {
  rows: Array<{ key: string; value: number; label?: string }>;
  tone?: "blue" | "violet" | "status";
  emptyText?: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (rows.length === 0 || max === 0) return <p className="fx-chart-empty">{emptyText}</p>;
  return (
    <ul className="fx-bars">
      {rows.map((r) => (
        <li key={r.key} className="fx-bars__row">
          <span className="fx-bars__key mono" title={r.key}>{r.label ?? r.key}</span>
          <span className="fx-bars__track">
            <span
              className={`fx-bars__fill${tone === "status" ? "" : ` fx-bars__fill--${tone}`}`}
              style={{
                width: `${(r.value / max) * 100}%`,
                ...(tone === "status" ? { background: `var(--fx-st-${workflowStatus(r.key).tone})` } : null),
              }}
            />
          </span>
          <span className="fx-bars__val num">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---- gauge ring: one bounded scalar vs its threshold ---- */

export function GaugeRing({
  value,
  max,
  label,
  unitSeconds = true,
}: {
  value: number | null;
  max: number;
  label: string;
  unitSeconds?: boolean;
}) {
  const frac = value === null ? 0 : Math.min(1, value / Math.max(max, 1e-9));
  const hot = value !== null && value > max;
  const R = 30;
  const C = 2 * Math.PI * R;
  const text = value === null ? "—" : unitSeconds ? humanDuration(value * 1000) : String(Math.round(value));
  return (
    <div className={`fx-gauge ${hot ? "fx-gauge--hot" : ""}`} role="img" aria-label={`${label}: ${text} of ${humanDuration(max * 1000)} budget`}>
      <svg viewBox="0 0 80 80" width="80" height="80">
        <circle cx="40" cy="40" r={R} fill="none" stroke="var(--fx-line)" strokeWidth="7" />
        <circle
          cx="40"
          cy="40"
          r={R}
          fill="none"
          stroke={hot ? "var(--fx-st-negative)" : "url(#fxgauge)"}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${frac * C} ${C}`}
          transform="rotate(-90 40 40)"
          className="fx-gauge__arc"
        />
        <defs>
          <linearGradient id="fxgauge" x1="0" y1="0" x2="80" y2="80">
            <stop stopColor="var(--fx-blue)" />
            <stop offset="1" stopColor="var(--fx-violet)" />
          </linearGradient>
        </defs>
        <text x="40" y="43" textAnchor="middle" className="fx-gauge__text">
          {text}
        </text>
      </svg>
      <span className="fx-gauge__label">{label}</span>
    </div>
  );
}

/* ---- transition flow strip: recent from→to edges (transitions counter) ---- */

export function TransitionBars({ rows }: { rows: Array<{ from: string; to: string; count: number }> }) {
  if (rows.length === 0) return <p className="fx-chart-empty">No transitions recorded yet.</p>;
  return (
    <ul className="fx-tflow">
      {rows.slice(0, 8).map((r) => (
        <li key={`${r.from}-${r.to}`} className="fx-tflow__row">
          <span className={`fx-tflow__state fx-tflow__state--${workflowStatus(r.from).tone}`}>{workflowStatus(r.from).label}</span>
          <span className="fx-tflow__arrow" aria-hidden="true">→</span>
          <span className={`fx-tflow__state fx-tflow__state--${workflowStatus(r.to).tone}`}>{workflowStatus(r.to).label}</span>
          <span className="fx-tflow__count num">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}
