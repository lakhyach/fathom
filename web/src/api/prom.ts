/* Prometheus exposition-format parser (text/plain; version=0.0.4 subset —
   exactly what client_golang v1.25 writes). Only the 11 fathom_* series the
   collector registers are surfaced; unknown families are parsed but ignored
   by screens. No fake series, ever (UI spec §3.5 honesty rule 1). */

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface MetricFamily {
  name: string;
  type: string; // counter | gauge | histogram | untyped
  help: string;
  samples: Sample[];
}

export type MetricMap = Record<string, MetricFamily>;

export function parsePrometheus(text: string): MetricMap {
  const out: MetricMap = {};
  let pending: { name: string; type: string; help: string } | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("# TYPE ")) {
      const [name, type] = line.slice(7).split(/\s+/);
      pending = { name, type, help: out[name]?.help ?? "" };
      getOrCreate(out, pending).type = type;
      continue;
    }
    if (line.startsWith("# HELP ")) {
      const rest = line.slice(7);
      const sp = rest.indexOf(" ");
      const name = rest.slice(0, sp);
      const help = rest.slice(sp + 1);
      const fam = getOrCreate(out, { name, type: out[name]?.type ?? "untyped", help });
      fam.help = help;
      continue;
    }
    if (line.startsWith("#")) continue;

    const parsed = parseSampleLine(line);
    if (!parsed) continue;
    // Families are keyed by EXACT sample name: folding _sum/_count into a
    // parent would corrupt real gauges like fathom_outbox_unpublished_count.
    // No histogram is wired server-side yet (gap G5), so no folding is needed.
    const fam = out[parsed.name] ?? getOrCreate(out, { name: parsed.name, type: pending?.name === parsed.name ? pending.type : "untyped", help: "" });
    fam.samples.push(parsed);
  }
  return out;
}

function getOrCreate(map: MetricMap, meta: { name: string; type: string; help: string }): MetricFamily {
  if (!map[meta.name]) {
    map[meta.name] = { name: meta.name, type: meta.type || "untyped", help: meta.help, samples: [] };
  }
  return map[meta.name];
}

function parseSampleLine(line: string): Sample | null {
  const brace = line.indexOf("{");
  if (brace === -1) {
    const m = /^(\S+)\s+([-+\d.eE]+|NaN|[+-]Inf)(\s+\d+)?$/.exec(line);
    if (!m) return null;
    return { name: m[1], labels: {}, value: toNumber(m[2]) };
  }
  const end = line.lastIndexOf("}");
  if (end === -1) return null;
  const name = line.slice(0, brace);
  const labels = parseLabels(line.slice(brace + 1, end));
  const rest = line.slice(end + 1).trim();
  const parts = rest.split(/\s+/);
  if (parts.length === 0 || !name) return null;
  return { name, labels, value: toNumber(parts[0]) };
}

function toNumber(s: string): number {
  if (s === "NaN") return Number.NaN;
  if (s === "+Inf") return Number.POSITIVE_INFINITY;
  if (s === "-Inf") return Number.NEGATIVE_INFINITY;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** label set parser honouring escaped quotes inside values. */
function parseLabels(src: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < src.length) {
    const eq = src.indexOf("=", i);
    if (eq === -1) break;
    const key = src.slice(i, eq).trim();
    let j = eq + 1; // at opening quote
    if (src[j] !== '"') {
      i = eq + 1;
      continue;
    }
    j++;
    let val = "";
    while (j < src.length && src[j] !== '"') {
      if (src[j] === "\\" && j + 1 < src.length) {
        const nxt = src[j + 1];
        val += nxt === "n" ? "\n" : nxt;
        j += 2;
      } else {
        val += src[j];
        j++;
      }
    }
    labels[key] = val;
    i = j + 1;
    while (i < src.length && (src[i] === "," || src[i] === " ")) i++;
  }
  return labels;
}

/* ---- fathom-specific selectors used by screens ---- */

export interface CensusRow {
  def_name: string;
  state: string;
  count: number;
}

/** fathom_workflows_total{def_name,state} — the durable census for Overview. */
export function workflowCensus(map: MetricMap): CensusRow[] {
  const fam = map["fathom_workflows_total"];
  if (!fam) return [];
  return fam.samples
    .filter((s) => s.labels.def_name !== undefined && s.labels.state !== undefined)
    .map((s) => ({ def_name: s.labels.def_name, state: s.labels.state, count: s.value }));
}

export function gaugeValue(map: MetricMap, name: string, labels?: Record<string, string>): number | null {
  const fam = map[name];
  if (!fam || fam.samples.length === 0) return null;
  const want = Object.entries(labels ?? {});
  const s = fam.samples.find((sm) => want.every(([k, v]) => sm.labels[k] === v));
  return s ? s.value : null;
}

/** all samples of a family with a label split (e.g. classification bars). */
export function byLabel(map: MetricMap, name: string, label: string): Array<{ key: string; value: number }> {
  const fam = map[name];
  if (!fam) return [];
  return fam.samples
    .filter((s) => s.labels[label] !== undefined)
    .map((s) => ({ key: s.labels[label], value: s.value }))
    .sort((a, b) => b.value - a.value);
}
