/* Client-side aggregation of real API rows — the only honest way to draw a
   time axis. /metrics carries cumulative counters and /v1/workflows carries
   no date filter, so every trend or percentile here is computed from the
   placement rows themselves. When the cursor walk could not cover a window,
   the caller says so on screen instead of drawing a confident lie. */
import type { WorkflowSummary } from "../api/types";

export type Outcome = "completed" | "negative" | "open";

const COMPLETED = new Set(["COMPLETED"]);
const NEGATIVE = new Set(["FAILED", "ABORTED", "FAILED_MANUAL"]);

export function outcomeOf(state: string): Outcome {
  if (COMPLETED.has(state)) return "completed";
  if (NEGATIVE.has(state)) return "negative";
  return "open";
}

export interface Bucket {
  start: number;
  completed: number;
  negative: number;
  open: number;
  total: number;
}

/** Fixed-width, right-aligned buckets over [now-range, now]. Rows outside the
 *  window are dropped, never clamped into the edge bucket. */
export function bucketPlacements(
  rows: readonly WorkflowSummary[],
  opts: { rangeMs: number; bucketMs: number; utc?: boolean; now?: number },
): Bucket[] {
  const { rangeMs, bucketMs } = opts;
  const now = opts.now ?? Date.now();
  const end = Math.ceil(now / bucketMs) * bucketMs;
  const count = Math.max(1, Math.round(rangeMs / bucketMs));
  const start = end - count * bucketMs;
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({
    start: start + i * bucketMs,
    completed: 0,
    negative: 0,
    open: 0,
    total: 0,
  }));
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t) || t < start || t >= end) continue;
    const b = buckets[Math.min(count - 1, Math.floor((t - start) / bucketMs))];
    b[outcomeOf(r.state)] += 1;
    b.total += 1;
  }
  return buckets;
}

/** Axis label: clock time inside a day, calendar date beyond it. */
export function bucketLabel(
  start: number,
  rangeMs: number,
  utc = false,
): string {
  const d = new Date(start);
  if (rangeMs > 36 * 3600_000) {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: utc ? "UTC" : undefined,
    }).format(d);
  }
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: utc ? "UTC" : undefined,
  }).format(d);
}

export interface Duration {
  id: string;
  label: string;
  ms: number;
  state: string;
}

/** created_at → finished_at wall time for rows that actually reached a
 *  terminal state. Open rows have no duration and are simply absent. */
export function wallTimes(rows: readonly WorkflowSummary[]): Duration[] {
  const out: Duration[] = [];
  for (const r of rows) {
    if (!r.finished_at) continue;
    const a = Date.parse(r.created_at);
    const b = Date.parse(r.finished_at);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
    out.push({
      id: r.id,
      label: `${r.def_name} · ${r.business_key}`,
      ms: b - a,
      state: r.state,
    });
  }
  return out.sort((x, y) => y.ms - x.ms);
}

/** Nearest-rank percentile of an unsorted sample list; null when empty. */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * xs.length));
  return xs[rank - 1];
}

export interface OutcomeSplit {
  completed: number;
  negative: number;
  open: number;
  terminal: number;
  total: number;
  /** completed / terminal — null when nothing has finished yet, so the caller
   *  renders "—" rather than a 0 % success rate it never measured. */
  successRate: number | null;
}

export function outcomeSplit(rows: readonly WorkflowSummary[]): OutcomeSplit {
  let completed = 0;
  let negative = 0;
  let open = 0;
  for (const r of rows) {
    const o = outcomeOf(r.state);
    if (o === "completed") completed += 1;
    else if (o === "negative") negative += 1;
    else open += 1;
  }
  const terminal = completed + negative;
  return {
    completed,
    negative,
    open,
    terminal,
    total: rows.length,
    successRate: terminal > 0 ? completed / terminal : null,
  };
}

export interface DefinitionRow {
  name: string;
  total: number;
  completed: number;
  negative: number;
  open: number;
}

/** One ranked row per definition, from the durable census (def_name × state). */
export function definitionLedger(
  census: readonly { def_name: string; state: string; count: number }[],
): DefinitionRow[] {
  const byDef = new Map<string, DefinitionRow>();
  for (const row of census) {
    const d = byDef.get(row.def_name) ?? {
      name: row.def_name,
      total: 0,
      completed: 0,
      negative: 0,
      open: 0,
    };
    d.total += row.count;
    d[outcomeOf(row.state)] += row.count;
    byDef.set(row.def_name, d);
  }
  return [...byDef.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name),
  );
}
