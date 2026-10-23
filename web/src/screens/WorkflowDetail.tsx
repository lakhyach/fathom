/* Execution inspector — the signature Nunatak surface, laid out to the Phase 6.1
   reference composition: a global KPI strip, an execution header, the workflow
   graph as the centrepiece with a real progress bar, a right-hand details rail,
   a tab strip, and lower operations panels (selected step · event log · execution
   metrics). Every value is a real StepView/Workflow/audit fact. The graph renders
   only the sequential chain the backend actually provides (position order +
   compensator attributes) — no inferred branching DAG, no fabricated trends, no
   CPU/memory telemetry the engine does not expose, no pause/cancel the machine
   does not admit. Unsupported views say so plainly. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Edge,
  type Node,
} from "@xyflow/react";

import { useAttempts, useDlq, useEvents, useInbound, useMetrics, useWorkflow, useWorkflowAction } from "../api/hooks";
import { workflowCensus } from "../api/prom";
import { StepNode } from "../graph/StepNode";
import { layoutGraph, type StepNodeData } from "../graph/layout";
import { classificationStatus, stepStatus, workflowStatus } from "../theme/status";
import {
  ConfirmAction,
  CopyChip,
  EmptyState,
  ErrorState,
  JsonView,
  LoadingRows,
  Panel,
  RelTime,
  SnapshotAt,
  StatusBadge,
  TimeText,
  humanDuration,
  truncate,
  useToast,
} from "../components/ui";
import {
  IconActivity,
  IconAlert,
  IconCancel,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconDeadLetter,
  IconExecution,
  IconInfo,
  IconJson,
  IconLayers,
  IconLogs,
  IconRefresh,
  IconRoute,
  IconUndo,
} from "../icons";
import type { Attempt, StepView, Workflow } from "../api/types";
import type { ReactNode } from "react";
import "./screens.css";

const TERMINAL = new Set(["COMPLETED", "FAILED", "ABORTED"]);
const DONE = new Set(["SUCCEEDED", "COMPENSATED"]);
const nodeTypes = { step: StepNode };

/* leading status sigil for the exec header — a tone-tinted circular chip that
   mirrors the node glyphs, so the header and the graph read as one system. */
function sigilGlyph(tone: string) {
  switch (tone) {
    case "completed":
      return <IconCheck size={16} />;
    case "running":
      return <IconExecution size={16} />;
    case "compensating":
      return <IconUndo size={16} />;
    case "negative":
      return <IconCancel size={16} />;
    case "manual":
      return <IconInfo size={16} />;
    case "warn":
      return <IconAlert size={16} />;
    default:
      return <IconClock size={16} />;
  }
}

type Tab = "flow" | "steps" | "events" | "attempts" | "io" | "audit" | "traces";

export function WorkflowDetail() {
  const { id } = useParams();
  const wf = useWorkflow(id);
  const [tab, setTab] = useState<Tab>("flow");
  const [selected, setSelected] = useState<string | null>(null);

  const steps = useMemo(() => wf.data?.steps ?? [], [wf.data]);
  const base = useMemo(() => layoutGraph(steps), [steps]);

  const nodes = useMemo(
    () => base.nodes.map((n) => ({ ...n, data: { ...n.data, selected: n.id === selected } })),
    [base, selected],
  );

  const pickStep = (stepType: string) => {
    setSelected((cur) => (cur === stepType ? null : stepType));
    setTab("flow");
  };
  const chosenStep = steps.find((s) => s.step_type === selected) ?? null;

  // Open the Step-details lower panel on real content instead of the empty state:
  // auto-select the current step once per workflow id. If the operator then
  // clears the selection it stays cleared — the guard is keyed on the id, not on
  // every poll, so background refetches never fight an intentional deselection.
  const autoKey = useRef<string>("");
  useEffect(() => {
    const key = id ?? "";
    if (autoKey.current === key || steps.length === 0) return;
    autoKey.current = key;
    const cur = steps.find((s) => !DONE.has(s.state)) ?? steps[steps.length - 1];
    setSelected(cur ? cur.step_type : null);
  }, [id, steps]);

  return (
    <div className="fx-screen fx-inspector">
      {wf.isLoading && <LoadingRows rows={5} />}
      {wf.isError && <ErrorState error={wf.error} onRetry={() => wf.refetch()} />}

      {wf.data && (
        <>
          <KpiStrip />

          <ExecHeader wf={wf.data} updatedAt={wf.dataUpdatedAt} />

          <div className="fx-insp-grid">
            <div className="fx-insp-main">
              <GraphPanel
                nodes={nodes}
                edges={base.edges}
                steps={steps}
                wf={wf.data}
                updatedAt={wf.dataUpdatedAt}
                chosen={chosenStep}
                onPick={pickStep}
              />

              <div className="fx-tabs" role="tablist" aria-label="Execution views">
                <TabButton id="flow" tab={tab} setTab={setTab} label="Execution Flow" Icon={IconExecution} />
                <TabButton id="steps" tab={tab} setTab={setTab} label="Steps" Icon={IconLayers} count={steps.length} />
                <TabButton id="events" tab={tab} setTab={setTab} label="Events" Icon={IconActivity} source={id} kind="inbound" />
                <TabButton id="attempts" tab={tab} setTab={setTab} label="Attempts" Icon={IconRefresh} source={id} kind="attempts" />
                <TabButton id="io" tab={tab} setTab={setTab} label="Input / Output" Icon={IconJson} />
                <TabButton id="audit" tab={tab} setTab={setTab} label="Audit Trail" Icon={IconLogs} source={id} kind="audit" />
                <TabButton id="traces" tab={tab} setTab={setTab} label="Traces" Icon={IconRoute} />
              </div>

              {tab === "flow" && (
                <div className="fx-lower">
                  <StepPanel step={chosenStep} />
                  <EventLogPanel id={id} />
                  <ExecMetricsPanel wf={wf.data} updatedAt={wf.dataUpdatedAt} />
                </div>
              )}
              {tab === "steps" && <StepsTable steps={steps} onPick={pickStep} chosen={chosenStep} />}
              {tab === "events" && <InboundTab id={id} />}
              {tab === "attempts" && <AttemptsTab id={id} />}
              {tab === "io" && <SpecTab wf={wf.data} />}
              {tab === "audit" && <AuditTab id={id} />}
              {tab === "traces" && <TracesTab id={id} />}
            </div>

            <aside className="fx-insp-side">
              <DetailsPanel wf={wf.data} onViewIO={() => setTab("io")} />
              <ActionPanel id={wf.data.id} state={wf.data.state} version={wf.data.version} />
            </aside>
          </div>

          <RelatedDeadLetterBar id={id} />
        </>
      )}
    </div>
  );
}

/* ------------------------------- KPI strip ------------------------------- */

function KpiStrip() {
  const metrics = useMetrics();
  const census = metrics.data ? workflowCensus(metrics.data) : [];
  const byState = new Map<string, number>();
  for (const row of census) byState.set(row.state, (byState.get(row.state) ?? 0) + row.count);
  const sum = (...keys: string[]) => keys.reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  const total = [...byState.values()].reduce((a, b) => a + b, 0);

  const cards = [
    { k: "Total", v: total, tone: "neutral" as const, icon: <IconLayers size={16} /> },
    { k: "Completed", v: sum("COMPLETED"), tone: "completed" as const, icon: <IconCheck size={16} /> },
    { k: "Active", v: sum("QUEUED", "RUNNING", "RETRY_WAITING", "COMPENSATING", "CANCELLING"), tone: "running" as const, icon: <IconExecution size={16} /> },
    { k: "Failed / aborted", v: sum("FAILED", "ABORTED"), tone: "negative" as const, icon: <IconAlert size={16} /> },
    { k: "Manual", v: sum("FAILED_MANUAL"), tone: "manual" as const, icon: <IconInfo size={16} /> },
  ];
  return (
    <div className="fx-kpi" aria-label="Fleet census">
      {metrics.isError ? (
        <div className="fx-kpi__err"><ErrorState error={metrics.error} onRetry={() => metrics.refetch()} /></div>
      ) : metrics.isLoading ? (
        <LoadingRows rows={1} />
      ) : (
        cards.map((c) => (
          <div key={c.k} className={`fx-kpi__card fx-kpi__card--${c.tone}`}>
            <span className="fx-kpi__k">{c.k}</span>
            <span className="fx-kpi__v num">{c.v}</span>
            <span className="fx-kpi__icon" aria-hidden="true">{c.icon}</span>
          </div>
        ))
      )}
    </div>
  );
}

/* ------------------------------ exec header ------------------------------ */

function ExecHeader({ wf, updatedAt }: { wf: Workflow; updatedAt: number }) {
  const running = !TERMINAL.has(wf.state);
  // Anchor "now" to the snapshot timestamp, not Date.now(): elapsed stays stable
  // within a render and still advances one poll at a time (dataUpdatedAt).
  const nowRef = wf.finished_at ? Date.parse(wf.finished_at) : updatedAt;
  const elapsed = wf.started_at && nowRef ? nowRef - Date.parse(wf.started_at) : null;
  const meta = workflowStatus(wf.state);
  return (
    <div className="fx-exec-head">
      <div className="fx-exec-head__main">
        <span className="fx-crumb">
          <Link to="/workflows" className="fx-link">Workflows</Link>
          <span aria-hidden="true"> / </span>
          <span className="mono" title={wf.id}>{truncate(wf.id, 14)}…</span>
        </span>
        <div className="fx-exec-titlerow">
          <span className={`fx-exec-sigil fx-exec-sigil--${meta.tone}`} aria-hidden="true">
            {sigilGlyph(meta.tone)}
          </span>
          <h1 className="fx-exec-title">
            {wf.def_name}
            <span className="fx-dim mono">v{wf.def_version}</span>
          </h1>
          <StatusBadge state={wf.state} />
        </div>
        <div className="fx-exec-meta">
          <span><span className="fx-dim">Started</span> <TimeText iso={wf.started_at} /></span>
          {elapsed !== null && <span><span className="fx-dim">Elapsed</span> {humanDuration(elapsed)}{running ? " · live" : ""}</span>}
          <span><span className="fx-dim">Definition</span> {wf.def_name}</span>
        </div>
      </div>
      <div className="fx-exec-head__side">
        {updatedAt > 0 && <SnapshotAt updatedAt={updatedAt} />}
      </div>
    </div>
  );
}

/* ------------------------------- graph panel ----------------------------- */

function GraphPanel({ nodes, edges, steps, wf, updatedAt, chosen, onPick }: {
  nodes: Node<StepNodeData>[];
  edges: Edge[];
  steps: StepView[];
  wf: Workflow;
  updatedAt: number;
  chosen: StepView | null;
  onPick: (t: string) => void;
}) {
  const railRef = useRef<HTMLUListElement>(null);

  const done = steps.filter((s) => DONE.has(s.state)).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  const current = steps.find((s) => !DONE.has(s.state)) ?? steps[steps.length - 1];
  const nowRef = wf.finished_at ? Date.parse(wf.finished_at) : updatedAt;
  const elapsed = wf.started_at && nowRef ? nowRef - Date.parse(wf.started_at) : null;

  if (steps.length === 0) {
    return (
      <Panel>
        <EmptyState icon={<IconExecution size={22} />} title="No steps recorded" hint="This workflow has no step rows to render." />
      </Panel>
    );
  }

  const onRailKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const btns = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>("button.fx-rail-step") ?? []);
    if (btns.length === 0) return;
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (dir !== undefined) {
      e.preventDefault();
      btns[(idx < 0 ? 0 : (idx + dir + btns.length) % btns.length)].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      btns[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      btns[btns.length - 1].focus();
    }
  };

  return (
    <section className="panel fx-graphpanel">
      <div className="fx-graph" role="group" aria-label="Workflow execution graph (visual) — use the step list for keyboard access">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => onPick(n.id)}
          fitView
          fitViewOptions={{ padding: 0.22, maxZoom: 1.35 }}
          minZoom={0.4}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--fx-line-faint)" />
        </ReactFlow>
      </div>

      <div className="fx-progress">
        <div className="fx-progress__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span className="fx-progress__fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="fx-progress__row">
          <span className="fx-progress__step">
            Step {current ? steps.findIndex((s) => s.step_type === current.step_type) + 1 : "—"} of {steps.length}
            {current && <span className="fx-dim"> · {current.step_type}</span>}
          </span>
          <span className="fx-progress__pct num">{pct}% complete</span>
          {elapsed !== null && <span className="fx-progress__el mono">{humanDuration(elapsed)} elapsed</span>}
        </div>
      </div>

      <div className="fx-rail-wrap">
        <p className="kicker">Steps · arrow keys to move, Enter to inspect</p>
        <ul className="fx-rail-steps" ref={railRef} onKeyDown={onRailKeyDown}>
          {steps.map((s, i) => {
            const m = stepStatus(s.state);
            return (
              <li key={s.step_type}>
                <button
                  type="button"
                  className={`fx-rail-step ${chosen?.step_type === s.step_type ? "fx-rail-step--on" : ""}`}
                  aria-pressed={chosen?.step_type === s.step_type}
                  onClick={() => onPick(s.step_type)}
                >
                  <span className="fx-rail-step__idx num">{i + 1}</span>
                  <span className={`fx-dot fx-dot--${m.tone}`} aria-hidden="true" />
                  <span className="fx-rail-step__type mono">{s.step_type}</span>
                  <StatusBadge state={s.state} kind="step" size="sm" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/* -------------------------------- tabs ---------------------------------- */

function TabButton({ id, label, tab, setTab, count, source, kind, Icon }: {
  id: Tab; label: string; tab: Tab; setTab: (t: Tab) => void; count?: number; source?: string; kind?: "audit" | "inbound" | "attempts"; Icon: (p: { size?: number }) => ReactNode;
}) {
  return (
    <button role="tab" aria-selected={tab === id} className={`fx-tab ${tab === id ? "fx-tab--on" : ""}`} onClick={() => setTab(id)}>
      <Icon size={13} />
      {label}
      {count != null && <span className="fx-tab__count">{count}</span>}
      {source && kind && <TabCount source={source} kind={kind} active={tab === id} />}
    </button>
  );
}

function TabCount({ source, kind, active }: { source: string; kind: "audit" | "inbound" | "attempts"; active: boolean }) {
  const audit = useEvents(active && kind === "audit" ? source : undefined, { limit: 1 });
  const inbound = useInbound(active && kind === "inbound" ? source : undefined, { limit: 1 });
  const attempts = useAttempts(active && kind === "attempts" ? source : undefined);
  const n = kind === "audit" ? audit.data?.items.length : kind === "inbound" ? inbound.data?.items.length : attempts.data?.length;
  return n ? <span className="fx-tab__count">{n}</span> : null;
}

/* ---------------------------- lower: step panel -------------------------- */

function StepPanel({ step }: { step: StepView | null }) {
  if (!step) {
    return (
      <Panel title={<h2>Step details</h2>} kicker="execution flow">
        <EmptyState icon={<IconInfo size={20} />} title="No step selected" hint="Click a node or a step row to inspect its state, attempts, lease and compensation." />
      </Panel>
    );
  }
  return (
    <Panel title={<h2>Step · <span className="mono">{step.step_type}</span></h2>} kicker="selected" >
      <div className="fx-stepdetail">
        <div className="fx-stepdetail__head">
          <StatusBadge state={step.state} kind="step" />
          <span className="fx-dim mono">position {step.position}</span>
        </div>
        <dl className="fx-meta-list">
          <div><span className="fx-meta-k">Attempts</span><span className="fx-meta-v num">{step.active_attempt} / {step.max_attempts}</span></div>
          <div><span className="fx-meta-k">Compensable</span><span className="fx-meta-v">{step.compensable ? "yes" : "no"}</span></div>
          {step.compensator_task && <div><span className="fx-meta-k">Compensator</span><span className="fx-meta-v mono">{step.compensator_task}</span></div>}
          <div><span className="fx-meta-k">Lease holder</span><span className="fx-meta-v mono">{step.lease_holder ?? "—"}</span></div>
          <div><span className="fx-meta-k">Lease expires</span><span className="fx-meta-v"><TimeText iso={step.lease_expires_at} timeOnly /></span></div>
          <div><span className="fx-meta-k">Response by</span><span className="fx-meta-v"><TimeText iso={step.response_deadline_at} timeOnly /></span></div>
          {step.compensation_deadline_at && <div><span className="fx-meta-k">Compensation by</span><span className="fx-meta-v"><TimeText iso={step.compensation_deadline_at} timeOnly /></span></div>}
        </dl>
      </div>
    </Panel>
  );
}

/* ---------------------------- lower: event log --------------------------- */

function EventLogPanel({ id }: { id: string | undefined }) {
  const events = useEvents(id, { limit: 40 });
  const rows = events.data?.items ?? [];
  return (
    <Panel title={<h2>Event log</h2>} kicker="audit transitions · newest first" bodyClass="fx-panel__body--flush">
      {events.isLoading && <div style={{ padding: 16 }}><LoadingRows rows={4} /></div>}
      {events.isError && <div style={{ padding: 16 }}><ErrorState error={events.error} /></div>}
      {!events.isLoading && rows.length === 0 && <EmptyState title="No transitions recorded" />}
      {rows.length > 0 && (
        <ul className="fx-log">
          {rows.map((a) => {
            const tone = workflowStatus(a.to_state).tone;
            return (
              <li key={a.seq} className="fx-log__row">
                <span className="fx-log__time mono"><TimeText iso={a.created_at} timeOnly /></span>
                <span className={`fx-log__lvl fx-log__lvl--${tone}`}>{a.kind}</span>
                <span className="fx-log__msg">
                  {a.from_state ? `${workflowStatus(a.from_state).label} → ${workflowStatus(a.to_state).label}` : workflowStatus(a.to_state).label}
                  <span className="fx-log__code mono">{a.reason_code}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------- lower: execution metrics ---------------------- */

function ExecMetricsPanel({ wf, updatedAt }: { wf: Workflow; updatedAt: number }) {
  const steps = wf.steps;
  const totalAttempts = steps.reduce((a, s) => a + s.active_attempt, 0);
  const compensable = steps.filter((s) => s.compensable).length;
  const wall = wf.started_at && wf.finished_at ? Date.parse(wf.finished_at) - Date.parse(wf.started_at) : null;
  const deadlineLeft = wf.deadline_at ? Date.parse(wf.deadline_at) - updatedAt : null;
  const metrics = [
    { k: "Steps", v: String(steps.length) },
    { k: "Attempts issued", v: String(totalAttempts) },
    { k: "Compensable", v: String(compensable) },
    { k: "Wall time", v: wall !== null ? humanDuration(wall) : "—" },
    { k: "Deadline", v: deadlineLeft !== null && !TERMINAL.has(wf.state) ? (deadlineLeft > 0 ? `${humanDuration(deadlineLeft)} left` : "breached") : "—" },
  ];
  return (
    <Panel title={<h2>Execution metrics</h2>} kicker="derived from real step data">
      <div className="fx-exec-tiles">
        {metrics.map((m) => (
          <div key={m.k} className="fx-exec-tile">
            <span className="fx-exec-tile__v num">{m.v}</span>
            <span className="fx-exec-tile__k">{m.k}</span>
          </div>
        ))}
      </div>
      <p className="fx-note">
        Host CPU, memory and connection telemetry are <strong>not exposed</strong> by the engine, so they are
        intentionally absent here rather than simulated.
      </p>
    </Panel>
  );
}

/* ------------------------------- steps table ----------------------------- */

function StepsTable({ steps, onPick, chosen }: { steps: StepView[]; onPick: (t: string) => void; chosen: StepView | null }) {
  return (
    <Panel bodyClass="fx-panel__body--flush">
      <table className="tbl">
        <thead>
          <tr><th>#</th><th>Step</th><th>State</th><th>Attempts</th><th>Lease</th><th>Compensator</th></tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.step_type} className={`fx-link-row ${chosen?.step_type === s.step_type ? "fx-row--on" : ""}`} onClick={() => onPick(s.step_type)}>
              <td className="num">{s.position}</td>
              <td className="mono">{s.step_type}</td>
              <td><StatusBadge state={s.state} kind="step" size="sm" /></td>
              <td className="num">{s.active_attempt}/{s.max_attempts}</td>
              <td className="mono fx-dim">{s.lease_holder ?? "—"}</td>
              <td className="mono fx-dim">{s.compensator_task ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

/* ------------------------------ attempts tab ----------------------------- */

function AttemptsTab({ id }: { id: string | undefined }) {
  const attempts = useAttempts(id);
  const [loading, error, items] = [attempts.isLoading, attempts.isError, attempts.data ?? []];
  const view = useMemo(() => buildGantt(items), [items]);
  return (
    <Panel bodyClass="fx-panel__body--flush">
      {loading && <LoadingRows rows={4} />}
      {error && <div style={{ padding: 16 }}><ErrorState error={attempts.error} onRetry={() => attempts.refetch()} /></div>}
      {!loading && !error && items.length === 0 && (
        <EmptyState title="No attempts yet" hint="Attempts are written the moment a worker claims a step and issues it." />
      )}
      {view && (
        <div className="fx-tl-wrap">
          <div className="fx-tl">
            {view.rows.map((r, i) => (
              <div key={`${r.a.step_type}-${r.a.number}-${i}`} className="fx-tl__row">
                <span className="fx-tl__step">{r.a.step_type}</span>
                <span className="fx-tl__num num">#{r.a.number}</span>
                <span className="fx-tl__track">
                  <span
                    className={`fx-tl__band fx-tl__band--${stepStatus(r.a.state).tone}`}
                    style={{ left: `${r.leftPct}%`, width: `${r.widthPct}%` }}
                    title={`${stepStatus(r.a.state).label} · ${humanDuration(r.durationMs)}`}
                  />
                </span>
                <span className="fx-tl__dur">{humanDuration(r.durationMs)}</span>
              </div>
            ))}
          </div>
          <div className="fx-tl__scale"><span>+0s</span><span>{humanDuration(view.spanMs)}</span></div>
          <p className="fx-note">
            Bands are aligned to a shared origin (earliest attempt start). Running attempts are measured to “now”,
            so their length grows until the step settles — durations are read from real started/finished timestamps.
          </p>
        </div>
      )}
    </Panel>
  );
}

interface GanttRow { a: Attempt; leftPct: number; widthPct: number; durationMs: number }

function buildGantt(items: Attempt[]): { rows: GanttRow[]; spanMs: number } | null {
  if (items.length === 0) return null;
  const now = Date.now();
  const starts = items.map((a) => Date.parse(a.started_at));
  const ends = items.map((a) => (a.finished_at ? Date.parse(a.finished_at) : now));
  const origin = Math.min(...starts);
  const horizon = Math.max(...ends);
  const span = Math.max(horizon - origin, 1);
  const rows = items.map((a) => {
    const s = Date.parse(a.started_at);
    const e = a.finished_at ? Date.parse(a.finished_at) : now;
    return { a, leftPct: ((s - origin) / span) * 100, widthPct: Math.max(((e - s) / span) * 100, 0.6), durationMs: e - s };
  });
  return { rows, spanMs: span };
}

/* -------------------------------- audit tab ------------------------------ */

function AuditTab({ id }: { id: string | undefined }) {
  const events = useEvents(id, { limit: 50 });
  const rows = events.data?.items ?? [];
  return (
    <Panel bodyClass="fx-panel__body--flush">
      {events.isLoading && <LoadingRows rows={4} />}
      {events.isError && <div style={{ padding: 16 }}><ErrorState error={events.error} /></div>}
      {!events.isLoading && rows.length === 0 && <EmptyState title="No transitions recorded" />}
      {rows.length > 0 && (
        <ul className="fx-feed">
          {rows.map((a) => (
            <li key={a.seq} className="fx-feed__item">
              <span className="fx-feed__gutter"><span className={`fx-feed__mark fx-feed__mark--${workflowStatus(a.to_state).tone}`} /></span>
              <div className="fx-feed__body">
                <div className="fx-feed__top">
                  <span className="fx-feed__title">{a.from_state ? `${workflowStatus(a.from_state).label} → ${workflowStatus(a.to_state).label}` : workflowStatus(a.to_state).label}</span>
                  <span className="fx-feed__code mono">{a.reason_code}</span>
                  <span className={`fx-badge fx-badge--sm fx-badge--${classificationStatus(a.kind).tone}`}><span className="fx-badge__label">{a.kind}</span></span>
                </div>
                <div className="fx-feed__meta"><TimeText iso={a.created_at} /><span className="fx-dim">seq {a.seq}</span>{a.trace_id && <span className="mono fx-dim">trace {truncate(a.trace_id, 12)}</span>}</div>
                {a.detail != null && <JsonView value={a.detail} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------- inbound tab ----------------------------- */

function InboundTab({ id }: { id: string | undefined }) {
  const inbound = useInbound(id, { limit: 50 });
  const rows = inbound.data?.items ?? [];
  return (
    <Panel bodyClass="fx-panel__body--flush">
      {inbound.isLoading && <LoadingRows rows={4} />}
      {inbound.isError && <div style={{ padding: 16 }}><ErrorState error={inbound.error} /></div>}
      {!inbound.isLoading && rows.length === 0 && <EmptyState title="No inbound events correlated" hint="Correlated Kafka/outbox events for this workflow will appear here." />}
      {rows.length > 0 && (
        <ul className="fx-feed">
          {rows.map((e) => (
            <li key={e.event_id} className="fx-feed__item">
              <span className="fx-feed__gutter"><span className={`fx-feed__mark fx-feed__mark--${classificationStatus(e.classification).tone}`} /></span>
              <div className="fx-feed__body">
                <div className="fx-feed__top">
                  <StatusBadge state={e.classification ?? ""} kind="classification" size="sm" />
                  {e.step_type && <span className="fx-feed__title">{e.step_type}</span>}
                  {e.attempt != null && <span className="fx-feed__code mono">attempt {e.attempt}</span>}
                </div>
                <div className="fx-feed__meta"><TimeText iso={e.received_at} /><CopyChip value={e.event_id} label={truncate(e.event_id, 16)} /></div>
                <JsonView value={e.raw} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* --------------------------------- io tab -------------------------------- */

function SpecTab({ wf }: { wf: Workflow }) {
  return (
    <div className="fx-grid-2">
      <Panel title={<h2>Instance input</h2>} kicker="workflow.input">
        <JsonView value={wf.input} collapsed={false} />
        <p className="fx-note fx-note--warn">
          Step <em>outputs</em> are not persisted or exposed by the engine, so only the instance input and the
          frozen definition snapshot are shown. Recording per-step output is a documented backend follow-up.
        </p>
      </Panel>
      <Panel title={<h2>Definition snapshot</h2>} kicker="frozen at creation">
        <JsonView value={wf.def_snapshot} collapsed={false} />
        <p className="fx-note">The engine stamps this snapshot when the instance is created, so a later re-registration of the definition never rewrites a running workflow’s steps.</p>
      </Panel>
    </div>
  );
}

/* ------------------------------- traces tab ------------------------------ */

function TracesTab({ id }: { id: string | undefined }) {
  const events = useEvents(id, { limit: 100 });
  const traces = useMemo(() => {
    const rows = events.data?.items ?? [];
    const seen = new Map<string, { count: number; last: string }>();
    for (const e of rows) {
      if (!e.trace_id) continue;
      const cur = seen.get(e.trace_id);
      if (cur) { cur.count += 1; if (e.created_at > cur.last) cur.last = e.created_at; }
      else seen.set(e.trace_id, { count: 1, last: e.created_at });
    }
    return [...seen.entries()];
  }, [events.data]);

  return (
    <Panel bodyClass="fx-panel__body--flush">
      {events.isLoading && <LoadingRows rows={3} />}
      {events.isError && <div style={{ padding: 16 }}><ErrorState error={events.error} /></div>}
      {!events.isLoading && (
        <div className="fx-traces">
          <p className="fx-note">
            There is no distributed-trace backend (gap G7). The identifiers below are the real <code className="mono">trace_id</code> values
            the engine already stamped on this workflow’s audit rows — shown for correlation, not as a full trace tree.
          </p>
          {traces.length === 0 ? (
            <EmptyState title="No trace identifiers stamped" hint="Audit rows for this workflow carry no trace_id." />
          ) : (
            <ul className="fx-traces__list">
              {traces.map(([tid, m]) => (
                <li key={tid} className="fx-traces__row">
                  <CopyChip value={tid} label={truncate(tid, 28)} />
                  <span className="fx-dim">{m.count} event{m.count === 1 ? "" : "s"}</span>
                  <span className="fx-dim mono">last <TimeText iso={m.last} timeOnly /></span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------ details rail ----------------------------- */

function DetailsPanel({ wf, onViewIO }: { wf: Workflow; onViewIO: () => void }) {
  const span = wf.started_at && wf.finished_at ? Date.parse(wf.finished_at) - Date.parse(wf.started_at) : null;
  const current = wf.steps.find((s) => !DONE.has(s.state)) ?? wf.steps[wf.steps.length - 1];
  return (
    <Panel title={<h2>Workflow details</h2>} kicker="live detail">
      <dl className="fx-meta-list">
        <div><span className="fx-meta-k">ID</span><span className="fx-meta-v"><CopyChip value={wf.id} label={`${truncate(wf.id, 18)}…`} /></span></div>
        <div><span className="fx-meta-k">Status</span><span className="fx-meta-v"><StatusBadge state={wf.state} /></span></div>
        <div><span className="fx-meta-k">Definition</span><span className="fx-meta-v">{wf.def_name} · v{wf.def_version}</span></div>
        <div><span className="fx-meta-k">Business key</span><span className="fx-meta-v mono">{wf.business_key}</span></div>
        <div><span className="fx-meta-k">Current step</span><span className="fx-meta-v mono">{current ? current.step_type : "—"}</span></div>
        <div><span className="fx-meta-k">Version</span><span className="fx-meta-v num">{wf.version}</span></div>
        <div><span className="fx-meta-k">Started</span><span className="fx-meta-v"><TimeText iso={wf.started_at} /></span></div>
        <div><span className="fx-meta-k">Duration</span><span className="fx-meta-v">{span !== null ? humanDuration(span) : "—"}</span></div>
        <div><span className="fx-meta-k">Deadline</span><span className="fx-meta-v"><TimeText iso={wf.deadline_at} /></span></div>
        <div><span className="fx-meta-k">Updated</span><span className="fx-meta-v"><RelTime iso={wf.updated_at} /></span></div>
      </dl>
      <button type="button" className="btn btn-sm fx-details__json" onClick={onViewIO}>
        <IconJson size={13} /> View input &amp; definition
      </button>
    </Panel>
  );
}

/* ------------------------------ action panel ----------------------------- */

function ActionPanel({ id, state, version }: { id: string; state: string; version: number }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<null | "cancel" | "retry-now">(null);
  const action = useWorkflowAction(id, confirm ?? "cancel");

  const terminal = TERMINAL.has(state);
  const manual = state === "FAILED_MANUAL";
  const cancelDisabled = terminal || manual || state === "CANCELLING";
  const retryDisabled = state !== "RETRY_WAITING";

  const cancelHint = terminal
    ? "Terminal workflows are immutable."
    : manual
      ? "Awaiting a dead-letter resolution — decide in the Dead Letter centre."
      : state === "CANCELLING"
        ? "Cancellation already in progress."
        : "Requests the engine stop forward progress and compensate what ran.";
  const retryHint = state === "RETRY_WAITING"
    ? "Skips the remaining back-off and re-issues the step now."
    : "Only available while the workflow is RETRY_WAITING.";

  return (
    <Panel title={<h2>Operator actions</h2>} kicker={`guarded by version ${version}`}>
      <div className="fx-actions">
        <button type="button" className="btn btn-sm" disabled={cancelDisabled} onClick={() => setConfirm("cancel")}>
          <IconCancel size={13} /> Cancel workflow
        </button>
        <button type="button" className="btn btn-sm" disabled={retryDisabled} onClick={() => setConfirm("retry-now")}>
          <IconRefresh size={13} /> Retry now
        </button>
      </div>
      <p className="fx-hintpick">{confirm === "retry-now" ? retryHint : cancelHint}</p>
      <p className="fx-note">
        The engine exposes no pause or priority control, so neither is offered. Both verbs send <code className="mono">version: {version}</code>;
        if the engine advanced first, the write answers 409 and re-reads before you retry.
      </p>

      {confirm && (
        <ConfirmAction
          title={confirm === "cancel" ? "Cancel this workflow" : "Force an immediate retry"}
          target={<span>workflow <code className="mono">{truncate(id, 18)}…</code> · currently <StatusBadge state={state} size="sm" /></span>}
          consequence={
            confirm === "cancel"
              ? "Forward progress stops; completed compensable steps are rolled back. This is recorded as an operator transition."
              : "The engine re-issues the pending step immediately instead of waiting for the back-off timer."
          }
          endpoint={`POST /v1/workflows/${id}/actions:${confirm === "cancel" ? "cancel" : "retry-now"}`}
          confirmLabel={confirm === "cancel" ? "Request cancel" : "Retry now"}
          danger={confirm === "cancel"}
          busy={action.isPending}
          error={action.error}
          onClose={() => setConfirm(null)}
          onConfirm={(reason) =>
            action.mutate(
              { reason, version },
              {
                onSuccess: (r) => { toast({ tone: "ok", text: `Advanced to ${workflowStatus(r.state).label} @ v${r.version}` }); setConfirm(null); },
                onError: () => undefined,
              },
            )
          }
        />
      )}
      <Link to={`/events?workflow=${id}`} className="btn btn-ghost btn-sm fx-actionlink"><IconLogs size={13} /> Open full event ledger</Link>
    </Panel>
  );
}

/* ---------------------- related dead letter / manual --------------------- */

/* The reference's bottom summary strip. The engine exposes a real dead-letter
   queue keyed by workflow, so the count and the newest reason are genuine — we
   filter defensively by workflow_id in case the server ignores the query, and
   never invent an entry. Zero is shown honestly as zero. */
function RelatedDeadLetterBar({ id }: { id: string | undefined }) {
  const dlq = useDlq({ workflow_id: id, open: true, limit: 20 });
  const items = (dlq.data?.items ?? []).filter((d) => d.workflow_id === id);
  const n = items.length;
  const newest = items[0];
  return (
    <Link to="/dlq" className={`fx-dlqbar ${n > 0 ? "fx-dlqbar--on" : ""}`}>
      <span className="fx-dlqbar__icon" aria-hidden="true"><IconDeadLetter size={16} /></span>
      <span className="fx-dlqbar__label">Related dead letter / manual interventions</span>
      <span className="fx-dlqbar__count num" aria-label={`${n} open`}>{dlq.isLoading ? "…" : n}</span>
      {n > 0 && newest && (
        <span className="fx-dlqbar__hint mono" title={newest.reason_code}>{newest.class} · {newest.reason_code}</span>
      )}
      <span className="fx-dlqbar__cta">Open centre <IconChevronRight size={14} /></span>
    </Link>
  );
}
