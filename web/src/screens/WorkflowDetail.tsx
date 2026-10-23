/* Execution inspector — the signature Fathom surface. It renders the real
   StepView chain (ordered by backend position) as an interactive graph with a
   parallel keyboard-navigable rail, then every fact the backend exposes per
   step: state, attempt counters, lease, deadlines, compensation and the full
   attempt timeline (from /attempts). Operator verbs (cancel / retry-now) are the
   only actions offered and only where the machine actually admits them, each
   guarded by a version-checked confirmation. Nothing here is decorative. */
import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Edge,
  type Node,
} from "@xyflow/react";

import { useAttempts, useEvents, useInbound, useWorkflow, useWorkflowAction } from "../api/hooks";
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
import { IconCancel, IconExecution, IconRefresh } from "../icons";
import type { Attempt, StepView } from "../api/types";
import "./screens.css";

const TERMINAL = new Set(["COMPLETED", "FAILED", "ABORTED"]);
const nodeTypes = { step: StepNode };

type Tab = "graph" | "attempts" | "audit" | "inbound" | "spec";

export function WorkflowDetail() {
  const { id } = useParams();
  const wf = useWorkflow(id);
  const [tab, setTab] = useState<Tab>("graph");
  const [selected, setSelected] = useState<string | null>(null);

  const steps = useMemo(() => wf.data?.steps ?? [], [wf.data]);
  const base = useMemo(() => layoutGraph(steps), [steps]);

  // controlled nodes derived from the latest steps + current selection; no
  // imperative node store is needed because the graph is read-only
  const nodes = useMemo(
    () => base.nodes.map((n) => ({ ...n, data: { ...n.data, selected: n.id === selected } })),
    [base, selected],
  );

  const pickStep = (stepType: string) => setSelected((cur) => (cur === stepType ? null : stepType));

  const chosenStep = steps.find((s) => s.step_type === selected) ?? null;

  return (
    <div className="fx-screen">
      {wf.isLoading && <LoadingRows rows={5} />}
      {wf.isError && <ErrorState error={wf.error} onRetry={() => wf.refetch()} />}

      {wf.data && (
        <>
          <div className="fx-detail-head">
            <div className="fx-detail-title">
              <span className="fx-crumb"><Link to="/workflows" className="fx-link">Workflows</Link> / {truncate(wf.data.id, 12)}…</span>
              <h1>
                {wf.data.def_name} <span className="fx-dim mono">v{wf.data.def_version}</span>
                <StatusBadge state={wf.data.state} />
              </h1>
              <div className="fx-feed__meta">
                <span className="mono">{wf.data.business_key}</span>
                <CopyChip value={wf.data.id} label="copy id" />
                <RelTime iso={wf.data.updated_at} />
              </div>
            </div>
            <div className="fx-page-head__side">
              {wf.dataUpdatedAt > 0 && <SnapshotAt updatedAt={wf.dataUpdatedAt} />}
            </div>
          </div>

          <div className="fx-detail-grid">
            <div>
              <div className="fx-tabs" role="tablist" aria-label="Execution views">
                <TabButton id="graph" tab={tab} setTab={setTab} label="Execution graph" count={steps.length} />
                <TabButton id="attempts" tab={tab} setTab={setTab} label="Attempts" source={id} />
                <TabButton id="audit" tab={tab} setTab={setTab} label="Audit" source={id} kind="audit" />
                <TabButton id="inbound" tab={tab} setTab={setTab} label="Inbound" source={id} kind="inbound" />
                <TabButton id="spec" tab={tab} setTab={setTab} label="Input &amp; definition" />
              </div>

              {tab === "graph" && (
                <GraphTab nodes={nodes} edges={base.edges} steps={steps} chosen={chosenStep} onPick={pickStep} />
              )}
              {tab === "attempts" && <AttemptsTab id={id} />}
              {tab === "audit" && <AuditTab id={id} />}
              {tab === "inbound" && <InboundTab id={id} />}
              {tab === "spec" && <SpecTab wf={wf.data} />}
            </div>

            <aside className="fx-detail-side">
              <MetaPanel wf={wf.data} />
              <ActionPanel id={wf.data.id} state={wf.data.state} version={wf.data.version} />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function TabButton({ id, label, tab, setTab, count, source, kind }: {
  id: Tab; label: string; tab: Tab; setTab: (t: Tab) => void; count?: number; source?: string; kind?: "audit" | "inbound";
}) {
  return (
    <button role="tab" aria-selected={tab === id} className={`fx-tab ${tab === id ? "fx-tab--on" : ""}`} onClick={() => setTab(id)}>
      {label}
      {count != null && <span className="fx-tab__count">{count}</span>}
      {source && kind && <TabCount source={source} kind={kind} active={tab === id} />}
    </button>
  );
}

function TabCount({ source, kind, active }: { source: string; kind: "audit" | "inbound"; active: boolean }) {
  const audit = useEvents(active ? source : undefined, { limit: 1 });
  const inbound = useInbound(active && kind === "inbound" ? source : undefined, { limit: 1 });
  const n = kind === "audit" ? audit.data?.items.length : inbound.data?.items.length;
  return n ? <span className="fx-tab__count">{n}</span> : null;
}

/* ------------------------------- graph tab ------------------------------- */

function GraphTab({ nodes, edges, steps, chosen, onPick }: {
  nodes: Node<StepNodeData>[];
  edges: Edge[];
  steps: StepView[];
  chosen: StepView | null;
  onPick: (t: string) => void;
}) {
  const railRef = useRef<HTMLUListElement>(null);
  if (steps.length === 0) {
    return (
      <Panel>
        <EmptyState icon={<IconExecution size={22} />} title="No steps recorded" hint="This workflow has no step rows to render." />
      </Panel>
    );
  }
  // roving focus across the step rail: arrows/Home/End move the caret between
  // steps, Enter/Space activate (native <button> behaviour). selection itself
  // stays with onClick so a focus move never mutates the inspected step.
  const onRailKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const btns = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>("button.fx-rail-step") ?? []);
    if (btns.length === 0) return;
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      btns[(idx < 0 ? 0 : (idx + step + btns.length) % btns.length)].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      btns[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      btns[btns.length - 1].focus();
    }
  };
  return (
    <div className="fx-graphwrap">
      <div className="fx-graph" role="group" aria-label="Workflow execution graph (visual) — use the step list for keyboard access">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => onPick(n.id)}
          fitView
          minZoom={0.4}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--fx-line-faint)" />
        </ReactFlow>
      </div>

      <div className="fx-graph-side">
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
        {chosen ? <StepDetail step={chosen} /> : <p className="fx-hintpick">Select a step — click a node or a row above — to inspect its lease, deadlines and compensation.</p>}
      </div>
    </div>
  );
}

function StepDetail({ step }: { step: StepView }) {
  return (
    <div className="fx-stepdetail">
      <div className="fx-stepdetail__head">
        <span className="mono">{step.step_type}</span>
        <StatusBadge state={step.state} kind="step" size="sm" />
      </div>
      <dl className="fx-meta-list">
        <div><span className="fx-meta-k">Position</span><span className="fx-meta-v num">{step.position}</span></div>
        <div><span className="fx-meta-k">Attempts</span><span className="fx-meta-v num">{step.active_attempt} / {step.max_attempts}</span></div>
        <div><span className="fx-meta-k">Compensable</span><span className="fx-meta-v">{step.compensable ? "yes" : "no"}</span></div>
        {step.compensator_task && <div><span className="fx-meta-k">Compensator</span><span className="fx-meta-v mono">{step.compensator_task}</span></div>}
        <div><span className="fx-meta-k">Lease holder</span><span className="fx-meta-v mono">{step.lease_holder ?? "—"}</span></div>
        <div><span className="fx-meta-k">Lease expires</span><span className="fx-meta-v"><TimeText iso={step.lease_expires_at} timeOnly /></span></div>
        <div><span className="fx-meta-k">Response by</span><span className="fx-meta-v"><TimeText iso={step.response_deadline_at} timeOnly /></span></div>
        {step.compensation_deadline_at && <div><span className="fx-meta-k">Compensation by</span><span className="fx-meta-v"><TimeText iso={step.compensation_deadline_at} timeOnly /></span></div>}
      </dl>
    </div>
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
    return {
      a,
      leftPct: ((s - origin) / span) * 100,
      widthPct: Math.max(((e - s) / span) * 100, 0.6),
      durationMs: e - s,
    };
  });
  return { rows, spanMs: span };
}

/* -------------------------------- audit tab ------------------------------- */

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

/* ------------------------------- inbound tab ------------------------------ */

function InboundTab({ id }: { id: string | undefined }) {
  const inbound = useInbound(id, { limit: 50 });
  const rows = inbound.data?.items ?? [];
  return (
    <Panel bodyClass="fx-panel__body--flush">
      {inbound.isLoading && <LoadingRows rows={4} />}
      {inbound.isError && <div style={{ padding: 16 }}><ErrorState error={inbound.error} /></div>}
      {!inbound.isLoading && rows.length === 0 && <EmptyState title="No inbound events correlated" />}
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

/* --------------------------------- spec tab ------------------------------- */

function SpecTab({ wf }: { wf: import("../api/types").Workflow }) {
  return (
    <div className="fx-grid-2">
      <Panel title={<h2>Instance input</h2>} kicker="workflow.input">
        <JsonView value={wf.input} collapsed={false} />
      </Panel>
      <Panel title={<h2>Definition snapshot</h2>} kicker="frozen at creation">
        <JsonView value={wf.def_snapshot} collapsed={false} />
        <p className="fx-note">The engine stamps this snapshot when the instance is created, so a later re-registration of the definition never rewrites a running workflow’s steps.</p>
      </Panel>
    </div>
  );
}

/* -------------------------------- meta rail ------------------------------- */

function MetaPanel({ wf }: { wf: import("../api/types").Workflow }) {
  const span = wf.started_at && wf.finished_at ? Date.parse(wf.finished_at) - Date.parse(wf.started_at) : null;
  return (
    <Panel title={<h2>Instance</h2>} kicker="live detail">
      <dl className="fx-meta-list">
        <div><span className="fx-meta-k">State</span><span className="fx-meta-v"><StatusBadge state={wf.state} /></span></div>
        <div><span className="fx-meta-k">Version</span><span className="fx-meta-v num">{wf.version}</span></div>
        <div><span className="fx-meta-k">Definition</span><span className="fx-meta-v">{wf.def_name} · v{wf.def_version}</span></div>
        <div><span className="fx-meta-k">Business key</span><span className="fx-meta-v mono">{wf.business_key}</span></div>
        <div><span className="fx-meta-k">Created</span><span className="fx-meta-v"><TimeText iso={wf.created_at} /></span></div>
        <div><span className="fx-meta-k">Started</span><span className="fx-meta-v"><TimeText iso={wf.started_at} /></span></div>
        <div><span className="fx-meta-k">Finished</span><span className="fx-meta-v"><TimeText iso={wf.finished_at} /></span></div>
        {wf.started_at && wf.finished_at && <div><span className="fx-meta-k">Wall time</span><span className="fx-meta-v">{humanDuration(span)}</span></div>}
        <div><span className="fx-meta-k">Deadline</span><span className="fx-meta-v"><TimeText iso={wf.deadline_at} /></span></div>
        {wf.next_attempt_at && <div><span className="fx-meta-k">Next attempt</span><span className="fx-meta-v"><TimeText iso={wf.next_attempt_at} timeOnly /></span></div>}
        <div><span className="fx-meta-k">Steps</span><span className="fx-meta-v num">{wf.steps.length}</span></div>
      </dl>
    </Panel>
  );
}

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
        Both verbs send <code className="mono">version: {version}</code> — the value currently read. If the engine
        advanced first, the write answers 409 and re-reads before you retry.
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
      <Link to={`/events?workflow=${id}`} className="btn btn-ghost btn-sm fx-actionlink"><IconExecution size={13} /> Open full event ledger</Link>
    </Panel>
  );
}
