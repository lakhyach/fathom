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

/* ------------------------- the honest time plane ------------------------- */

/** Minimum span an axis may show, so a single placement never stretches a
 *  full-width bar with no context around it. */
const MIN_AXIS_MS = 60 * 60_000;

export interface TimePlane {
  /** left edge of the axis, in epoch ms */
  from: number;
  /** right edge of the axis, in epoch ms */
  to: number;
  /** epoch ms of the newest real mark, or null when the window is empty */
  last: number | null;
  /** true → the axis was fitted to the marks that exist rather than showing
   *  the whole selected range. The caller says so on screen. */
  fitted: boolean;
  /** epoch ms the selected range actually started at */
  windowStart: number;
  spanMs: number;
}

/** Marks are the timestamps the ledger really carries: every created_at, every
 *  finished_at, and "now" for anything still open. The axis is fitted to that
 *  set (padded, never beyond now) instead of to the nominal range — the old
 *  fixed daily buckets made a two-day cluster read as one lonely bar. */
export function timePlane(
  rows: readonly WorkflowSummary[],
  opts: { rangeMs: number; now?: number },
): TimePlane {
  const now = opts.now ?? Date.now();
  const windowStart = now - opts.rangeMs;
  const marks: number[] = [];
  for (const r of rows) {
    const c = Date.parse(r.created_at);
    if (Number.isFinite(c) && c >= windowStart && c <= now) marks.push(c);
    if (r.finished_at) {
      const f = Date.parse(r.finished_at);
      if (Number.isFinite(f) && f >= windowStart && f <= now) marks.push(f);
    } else if (Number.isFinite(c) && c >= windowStart) {
      marks.push(now);
    }
  }
  if (marks.length === 0) {
    return {
      from: windowStart,
      to: now,
      last: null,
      fitted: false,
      windowStart,
      spanMs: now - windowStart,
    };
  }
  let first = Math.min(...marks);
  let last = Math.max(...marks);
  if (last - first < MIN_AXIS_MS) {
    const mid = (first + last) / 2;
    first = mid - MIN_AXIS_MS / 2;
    last = mid + MIN_AXIS_MS / 2;
  }
  const raw = last - first;
  const pad = Math.max(2 * 60_000, raw * 0.04);
  const from = Math.max(windowStart - pad, first - pad);
  const to = Math.min(now + pad, last + pad);
  const full = opts.rangeMs;
  return {
    from,
    to,
    last,
    fitted: to - from < full * 0.9,
    windowStart,
    spanMs: to - from,
  };
}

/** Even tick times across a fitted axis: rounded unit steps, real clock values. */
export function axisTicks(
  plane: TimePlane,
  count = 6,
): Array<{ t: number; label: string }> {
  const span = plane.to - plane.from;
  if (span <= 0) return [];
  const unit = 10 * 60_000;
  const rough = span / count;
  const step =
    [
      unit,
      2 * unit,
      5 * unit,
      15 * unit,
      30 * unit,
      3600_000,
      3 * 3600_000,
      6 * 3600_000,
      12 * 3600_000,
      864e5,
    ].find((s) => s >= rough) ?? 864e5;
  const first = Math.ceil(plane.from / step) * step;
  const out: Array<{ t: number; label: string }> = [];
  for (let t = first; t <= plane.to; t += step)
    out.push({ t, label: bucketLabel(t, span, false) });
  return out;
}

export interface Track {
  id: string;
  def: string;
  key: string;
  state: string;
  outcome: Outcome;
  created: number;
  updated: number;
  /** finished_at for terminal rows, the snapshot moment for open ones */
  end: number;
  open: boolean;
  /** true when the row was placed before the axis began */
  before: boolean;
}

/** One row per placement — the ledger itself, so a seven-workflow fleet renders
 *  as seven real spans instead of two bars in an empty field. */
export function timelineTracks(
  rows: readonly WorkflowSummary[],
  plane: TimePlane,
  now = Date.now(),
): Track[] {
  const out: Track[] = [];
  for (const r of rows) {
    const created = Date.parse(r.created_at);
    if (!Number.isFinite(created)) continue;
    const finished = r.finished_at ? Date.parse(r.finished_at) : Number.NaN;
    const updated = Date.parse(r.updated_at);
    const open = Number.isNaN(finished);
    out.push({
      id: r.id,
      def: r.def_name,
      key: r.business_key,
      state: r.state,
      outcome: outcomeOf(r.state),
      created,
      updated: Number.isFinite(updated) ? updated : created,
      end: open ? now : finished,
      open,
      before: created < plane.from,
    });
  }
  return out.sort((a, b) => b.created - a.created);
}

/* ----------------------------- activity matrix ----------------------------- */

export type CellKind =
  /** the row did not exist yet in this slot */
  | "none"
  /** created_at falls in this slot */
  | "placed"
  /** in flight across this slot (open lifecycle) */
  | "inflight"
  /** the ledger row last moved inside an already-open lifecycle */
  | "progressed"
  | "completed"
  | "negative"
  | "manual"
  /** terminal, and nothing happened since */
  | "settled"
  /** the cursor walk did not reach this slot */
  | "uncovered";

export interface MatrixCell {
  kind: CellKind;
  from: number;
  to: number;
  /** the workflow's own state, when the cell says something about it */
  state: string | null;
}

export interface MatrixRow {
  id: string;
  def: string;
  key: string;
  state: string;
  created: number;
  updated: number;
  finished: number | null;
  cells: MatrixCell[];
}

/** Columns × placements: what the ledger really recorded for each workflow in
 *  each slot. `updated_at` only ever proves "the row moved", never a step
 *  boundary, so it is drawn as a distinct class rather than a fake event. */
export function activityMatrix(
  rows: readonly WorkflowSummary[],
  opts: { plane: TimePlane; columns: number; covered: boolean; now?: number },
): MatrixRow[] {
  const now = opts.now ?? Date.now();
  const { from, to } = opts.plane;
  const width = (to - from) / opts.columns;
  if (width <= 0) return [];
  const colOf = (t: number) =>
    Math.max(0, Math.min(opts.columns - 1, Math.floor((t - from) / width)));
  return timelineTracks(rows, opts.plane, now)
    .slice(0, 8)
    .map((tr) => {
      const cCreated = colOf(tr.created);
      const cFinished = tr.open ? -1 : colOf(tr.end);
      const cUpdated = colOf(tr.updated);
      const cells: MatrixCell[] = Array.from(
        { length: opts.columns },
        (_, i) => {
          const start = from + i * width;
          const end = start + width;
          const uncovered =
            !opts.covered &&
            i < cCreated &&
            start < opts.plane.windowStart &&
            i < colOf(opts.plane.windowStart);
          let kind: CellKind;
          if (uncovered) kind = "uncovered";
          else if (i < cCreated) kind = "none";
          else if (i === cCreated) kind = "placed";
          else if (cFinished >= 0 && i === cFinished)
            kind =
              tr.state === "FAILED_MANUAL"
                ? "manual"
                : tr.outcome === "completed"
                  ? "completed"
                  : "negative";
          else if (cFinished >= 0 && i > cFinished) kind = "settled";
          else kind = i === cUpdated ? "progressed" : "inflight";
          return {
            kind,
            from: start,
            to: end,
            state: kind === "none" || kind === "uncovered" ? null : tr.state,
          };
        },
      );
      return {
        id: tr.id,
        def: tr.def,
        key: tr.key,
        state: tr.state,
        created: tr.created,
        updated: tr.updated,
        finished: tr.open ? null : tr.end,
        cells,
      };
    });
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
