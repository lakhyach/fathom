/* Execution inspector — the signature Nunatak surface: a global KPI strip, an
   execution header, the workflow graph as the centrepiece with a real progress
   bar, a right-hand details rail, a tab strip, and lower operations panels
   (selected step · event log · execution metrics). Every value is a real
   StepView/Workflow/audit fact. The graph renders only the sequential chain the
   backend actually provides (position order + compensator attributes) — no
   inferred branching DAG, no fabricated trends, no CPU/memory telemetry the
   engine does not expose, no pause/cancel the machine does not admit.
   Unsupported views say so plainly.

   Built on: Tailwind layout, kit Panel/KpiCard/StatusBadge/ConfirmAction,
   shadcn Table/Button, lucide glyphs, React Flow graph. Data logic unchanged. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Activity,
  Braces,
  Check,
  ChevronRight,
  CircleSlash,
  Clock,
  Inbox,
  Info,
  Layers,
  Play,
  RefreshCw,
  Route,
  ScrollText,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";

import {
  useAttempts,
  useDlq,
  useEvents,
  useInbound,
  useMetrics,
  useWorkflow,
  useWorkflowAction,
} from "../api/hooks";
import { workflowCensus } from "../api/prom";
import { StepNode } from "../graph/StepNode";
import {
  columnsFor,
  graphSpan,
  layoutGraph,
  type StepNodeData,
} from "../graph/layout";
import {
  classificationStatus,
  stepStatus,
  toneVar,
  workflowStatus,
} from "../theme/status";
import {
  ConfirmAction,
  CopyChip,
  EmptyState,
  ErrorState,
  JsonView,
  KpiCard,
  LoadingRows,
  Panel,
  PageHeader,
  RelTime,
  SnapshotAt,
  StatusBadge,
  TimeText,
  humanDuration,
  truncate,
  useToast,
} from "../components/ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Attempt, StepView, Workflow } from "../api/types";

const TERMINAL = new Set(["COMPLETED", "FAILED", "ABORTED"]);
const DONE = new Set(["SUCCEEDED", "COMPENSATED"]);
const nodeTypes = { step: StepNode };

/* leading status sigil for the exec header — a tone-tinted circular chip that
   mirrors the node glyphs, so the header and the graph read as one system. */
function sigilGlyph(tone: string): ReactNode {
  const cls = "size-4";
  switch (tone) {
    case "completed":
      return <Check className={cls} />;
    case "running":
      return <Play className={cls} />;
    case "compensating":
      return <Undo2 className={cls} />;
    case "negative":
      return <CircleSlash className={cls} />;
    case "manual":
      return <Info className={cls} />;
    case "warn":
      return <TriangleAlert className={cls} />;
    default:
      return <Clock className={cls} />;
  }
}

type Tab = "flow" | "steps" | "events" | "attempts" | "io" | "audit" | "traces";

export function WorkflowDetail() {
  const { id } = useParams();
  const wf = useWorkflow(id);
  const [tab, setTab] = useState<Tab>("flow");
  const [selected, setSelected] = useState<string | null>(null);

  const steps = useMemo(() => wf.data?.steps ?? [], [wf.data]);
  const base = useMemo(
    () => layoutGraph(steps, columnsFor(steps.length)),
    [steps],
  );

  const nodes = useMemo(
    () =>
      base.nodes.map((n) => ({
        ...n,
        data: { ...n.data, selected: n.id === selected },
      })),
    [base, selected],
  );

  // selection spotlight: when a step is chosen, its incident connectors stay lit
  // and every other edge recedes — reinforces the node↔edge↔rail selection sync
  // without inventing traversal (only emphasising edges the engine really drew).
  const edges = useMemo(
    () =>
      base.edges.map((e) => {
        if (!selected) return e;
        const incident = e.source === selected || e.target === selected;
        return { ...e, style: { ...e.style, opacity: incident ? 1 : 0.25 } };
      }),
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
    const cur =
      steps.find((s) => !DONE.has(s.state)) ?? steps[steps.length - 1];
    setSelected(cur ? cur.step_type : null);
  }, [id, steps]);

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      {!wf.data && (
        <PageHeader
          kicker="Execution inspector"
          title="Workflow"
          sub={
            <span className="font-mono text-[13px]">
              {id ?? "no workflow id in this route"}
            </span>
          }
        />
      )}
      {wf.isLoading && <LoadingRows rows={5} />}
      {wf.isError && (
        <ErrorState error={wf.error} onRetry={() => wf.refetch()} />
      )}

      {wf.data && (
        <>
          <KpiStrip />

          <ExecHeader wf={wf.data} updatedAt={wf.dataUpdatedAt} />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex min-w-0 flex-col gap-4">
              <GraphPanel
                nodes={nodes}
                edges={edges}
                steps={steps}
                wf={wf.data}
                updatedAt={wf.dataUpdatedAt}
                chosen={chosenStep}
                onPick={pickStep}
              />

              <div
                className="flex flex-wrap gap-1.5"
                role="tablist"
                aria-label="Execution views"
              >
                <TabButton
                  id="flow"
                  tab={tab}
                  setTab={setTab}
                  label="Execution Flow"
                  Icon={Play}
                />
                <TabButton
                  id="steps"
                  tab={tab}
                  setTab={setTab}
                  label="Steps"
                  Icon={Layers}
                  count={steps.length}
                />
                <TabButton
                  id="events"
                  tab={tab}
                  setTab={setTab}
                  label="Events"
                  Icon={Activity}
                  source={id}
                  kind="inbound"
                />
                <TabButton
                  id="attempts"
                  tab={tab}
                  setTab={setTab}
                  label="Attempts"
                  Icon={RefreshCw}
                  source={id}
                  kind="attempts"
                />
                <TabButton
                  id="io"
                  tab={tab}
                  setTab={setTab}
                  label="Input / Output"
                  Icon={Braces}
                />
                <TabButton
                  id="audit"
                  tab={tab}
                  setTab={setTab}
                  label="Audit Trail"
                  Icon={ScrollText}
                  source={id}
                  kind="audit"
                />
                <TabButton
                  id="traces"
                  tab={tab}
                  setTab={setTab}
                  label="Traces"
                  Icon={Route}
                />
              </div>

              {tab === "flow" && (
                <div className="grid gap-4 lg:grid-cols-3">
                  <StepPanel step={chosenStep} />
                  <EventLogPanel id={id} />
                  <ExecMetricsPanel wf={wf.data} updatedAt={wf.dataUpdatedAt} />
                </div>
              )}
              {tab === "steps" && (
                <StepsTable
                  steps={steps}
                  onPick={pickStep}
                  chosen={chosenStep}
                />
              )}
              {tab === "events" && <InboundTab id={id} />}
              {tab === "attempts" && <AttemptsTab id={id} />}
              {tab === "io" && <SpecTab wf={wf.data} />}
              {tab === "audit" && <AuditTab id={id} />}
              {tab === "traces" && <TracesTab id={id} />}
            </div>

            <aside className="flex min-w-0 flex-col gap-4">
              <DetailsPanel wf={wf.data} onViewIO={() => setTab("io")} />
              <ActionPanel
                id={wf.data.id}
                state={wf.data.state}
                version={wf.data.version}
              />
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
  for (const row of census)
    byState.set(row.state, (byState.get(row.state) ?? 0) + row.count);
  const sum = (...keys: string[]) =>
    keys.reduce((a, s) => a + (byState.get(s) ?? 0), 0);
  const total = [...byState.values()].reduce((a, b) => a + b, 0);

  const cards = [
    {
      k: "Total",
      v: total,
      tone: "neutral" as const,
      icon: <Layers className="size-4" />,
    },
    {
      k: "Completed",
      v: sum("COMPLETED"),
      tone: "completed" as const,
      icon: <Check className="size-4" />,
    },
    {
      k: "Active",
      v: sum(
        "QUEUED",
        "RUNNING",
        "RETRY_WAITING",
        "COMPENSATING",
        "CANCELLING",
      ),
      tone: "running" as const,
      icon: <Play className="size-4" />,
    },
    {
      k: "Failed / aborted",
      v: sum("FAILED", "ABORTED"),
      tone: "negative" as const,
      icon: <TriangleAlert className="size-4" />,
    },
    {
      k: "Manual",
      v: sum("FAILED_MANUAL"),
      tone: "manual" as const,
      icon: <Info className="size-4" />,
    },
  ];
  return (
    <div
      aria-label="Fleet census"
      className="mb-4 grid grid-cols-2 gap-2.5 sm:gap-3 max-xl:[&>*:last-child:nth-child(odd)]:col-span-2 lg:grid-cols-3 xl:grid-cols-5"
    >
      {metrics.isError ? (
        <div className="col-span-2 lg:col-span-3 xl:col-span-5">
          <ErrorState error={metrics.error} onRetry={() => metrics.refetch()} />
        </div>
      ) : metrics.isLoading ? (
        <LoadingRows rows={1} />
      ) : (
        cards.map((c, i) => (
          <KpiCard
            key={c.k}
            index={i}
            kicker={c.k}
            value={c.v}
            tone={c.tone}
            icon={c.icon}
          />
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
  const elapsed =
    wf.started_at && nowRef ? nowRef - Date.parse(wf.started_at) : null;
  const meta = workflowStatus(wf.state);
  return (
    <div className="surface-card mb-4 flex flex-wrap items-start justify-between gap-4 rounded-xl px-5 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Link to="/workflows" className="text-primary hover:underline">
            Workflows
          </Link>
          <span aria-hidden="true">/</span>
          <span className="font-mono" title={wf.id}>
            {truncate(wf.id, 14)}…
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span
            className="grid size-9 place-items-center rounded-full border"
            style={{
              color: toneVar(meta.tone),
              borderColor: toneVar(meta.tone),
            }}
            aria-hidden="true"
          >
            {sigilGlyph(meta.tone)}
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {wf.def_name}{" "}
            <span className="font-mono text-sm font-normal text-muted-foreground">
              v{wf.def_version}
            </span>
          </h1>
          <StatusBadge state={wf.state} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
          <span>
            <span className="text-muted-foreground/80">Started</span>{" "}
            <TimeText iso={wf.started_at} />
          </span>
          {elapsed !== null && (
            <span>
              <span className="text-muted-foreground/80">Elapsed</span>{" "}
              {humanDuration(elapsed)}
              {running ? " · live" : ""}
            </span>
          )}
          <span>
            <span className="text-muted-foreground/80">Definition</span>{" "}
            {wf.def_name}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {updatedAt > 0 && <SnapshotAt updatedAt={updatedAt} />}
      </div>
    </div>
  );
}

/* ------------------------------- graph panel ----------------------------- */

function GraphPanel({
  nodes,
  edges,
  steps,
  wf,
  updatedAt,
  chosen,
  onPick,
}: {
  nodes: Node<StepNodeData>[];
  edges: Edge[];
  steps: StepView[];
  wf: Workflow;
  updatedAt: number;
  chosen: StepView | null;
  onPick: (t: string) => void;
}) {
  const railRef = useRef<HTMLUListElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<Node<StepNodeData>, Edge> | null>(
    null,
  );
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setStageBox((cur) =>
        Math.abs(cur.w - width) < 1 && Math.abs(cur.h - height) < 1
          ? cur
          : { w: width, h: height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Frame the WHOLE chain. The inspector answers "where does this saga stand",
     so the default view never leaves a step off-canvas: the layout folds long
     chains into rows and the fit is allowed to zoom out far enough to show all
     of them. A deliberate operator pan/zoom is not stolen back on a poll. */
  const span = graphSpan(steps.length, columnsFor(steps.length));
  useEffect(() => {
    const rf = flowRef.current;
    if (!rf || stageBox.w === 0 || steps.length === 0) return;
    rf.fitView({ padding: 0.06, minZoom: 0.45, maxZoom: 1.35, duration: 220 });
  }, [span.w, span.h, stageBox.w, stageBox.h, steps.length]);

  const done = steps.filter((s) => DONE.has(s.state)).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  const current =
    steps.find((s) => !DONE.has(s.state)) ?? steps[steps.length - 1];
  const nowRef = wf.finished_at ? Date.parse(wf.finished_at) : updatedAt;
  const elapsed =
    wf.started_at && nowRef ? nowRef - Date.parse(wf.started_at) : null;

  if (steps.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={<Play className="size-5" />}
          title="No steps recorded"
          hint="This workflow has no step rows to render."
        />
      </Panel>
    );
  }

  const onRailKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const btns = Array.from(
      railRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-rail-step]",
      ) ?? [],
    );
    if (btns.length === 0) return;
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
      e.key
    ];
    if (dir !== undefined) {
      e.preventDefault();
      btns[idx < 0 ? 0 : (idx + dir + btns.length) % btns.length].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      btns[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      btns[btns.length - 1].focus();
    }
  };

  return (
    <section className="surface-card overflow-hidden rounded-[20px]">
      <div
        ref={stageRef}
        className="flow-stage h-[344px] w-full overflow-hidden border-b border-border/60 lg:h-[398px]"
        role="group"
        aria-label="Workflow execution graph (visual) — use the step list for keyboard access"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => onPick(n.id)}
          onInit={(inst) => {
            flowRef.current = inst as ReactFlowInstance<
              Node<StepNodeData>,
              Edge
            >;
          }}
          minZoom={0.3}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.4}
            color="oklch(0.79 0.165 145 / 13%)"
          />
          <Controls showInteractive={false} position="bottom-left" />
          {steps.length > 5 && (
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              style={{ width: 132, height: 64 }}
              maskColor="oklch(0.156 0.015 140 / 82%)"
              bgColor="var(--card)"
              nodeStrokeWidth={3}
              nodeColor={(n) =>
                toneVar(stepStatus((n.data as StepNodeData).step.state).tone)
              }
            />
          )}
        </ReactFlow>
      </div>

      <div className="px-5 py-3">
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            className="block h-full rounded-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            Step{" "}
            {current
              ? steps.findIndex((s) => s.step_type === current.step_type) + 1
              : "—"}{" "}
            of {steps.length}
            {current && <span> · {current.step_type}</span>}
          </span>
          <span className="font-mono tabular-nums">{pct}% complete</span>
          {elapsed !== null && (
            <span className="font-mono">{humanDuration(elapsed)} elapsed</span>
          )}
        </div>
      </div>

      <div className="border-t border-border/60 px-5 py-3">
        <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Steps · arrow keys to move, Enter to inspect
        </p>
        <ul
          className="mt-2 flex max-h-64 flex-col gap-0.5 overflow-auto"
          ref={railRef}
          onKeyDown={onRailKeyDown}
        >
          {steps.map((s, i) => {
            const m = stepStatus(s.state);
            const on = chosen?.step_type === s.step_type;
            return (
              <li key={s.step_type}>
                <button
                  type="button"
                  data-rail-step
                  aria-pressed={on}
                  onClick={() => onPick(s.step_type)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left text-sm transition-colors",
                    on
                      ? "border-primary/40 bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-accent/40",
                  )}
                >
                  <span className="grid size-5 shrink-0 place-items-center rounded bg-chip font-mono text-[11px]">
                    {i + 1}
                  </span>
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: toneVar(m.tone) }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium">
                    {s.step_type}
                  </span>
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

function TabButton({
  id,
  label,
  tab,
  setTab,
  count,
  source,
  kind,
  Icon,
}: {
  id: Tab;
  label: string;
  tab: Tab;
  setTab: (t: Tab) => void;
  count?: number;
  source?: string;
  kind?: "audit" | "inbound" | "attempts";
  Icon: LucideIcon;
}) {
  const on = tab === id;
  return (
    <button
      role="tab"
      aria-selected={on}
      onClick={() => setTab(id)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors",
        on
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
      {count != null && (
        <span className="font-mono text-xs opacity-70">{count}</span>
      )}
      {source && kind && <TabCount source={source} kind={kind} active={on} />}
    </button>
  );
}

function TabCount({
  source,
  kind,
  active,
}: {
  source: string;
  kind: "audit" | "inbound" | "attempts";
  active: boolean;
}) {
  const audit = useEvents(active && kind === "audit" ? source : undefined, {
    limit: 1,
  });
  const inbound = useInbound(
    active && kind === "inbound" ? source : undefined,
    { limit: 1 },
  );
  const attempts = useAttempts(
    active && kind === "attempts" ? source : undefined,
  );
  const n =
    kind === "audit"
      ? audit.data?.items.length
      : kind === "inbound"
        ? inbound.data?.items.length
        : attempts.data?.length;
  return n ? (
    <span className="ml-1 font-mono text-xs opacity-70">{n}</span>
  ) : null;
}

/* ---------------------------- lower: step panel -------------------------- */

function StepPanel({ step }: { step: StepView | null }) {
  if (!step) {
    return (
      <Panel title={<h2>Step details</h2>} kicker="execution flow">
        <EmptyState
          icon={<Info className="size-5" />}
          title="No step selected"
          hint="Click a node or a step row to inspect its state, attempts, lease and compensation."
        />
      </Panel>
    );
  }
  return (
    <Panel
      title={
        <h2 className="flex items-center gap-1.5">
          Step · <span className="font-mono">{step.step_type}</span>
        </h2>
      }
      kicker="selected"
    >
      <div className="mb-3 flex items-center gap-3">
        <StatusBadge state={step.state} kind="step" />
        <span className="font-mono text-xs text-muted-foreground">
          position {step.position}
        </span>
      </div>
      <MetaList
        rows={[
          [
            "Attempts",
            <span className="font-mono tabular-nums">
              {step.active_attempt} / {step.max_attempts}
            </span>,
          ],
          ["Compensable", step.compensable ? "yes" : "no"],
          ...(step.compensator_task
            ? [
                [
                  "Compensator",
                  <span className="font-mono">{step.compensator_task}</span>,
                ] as const,
              ]
            : []),
          [
            "Lease holder",
            <span className="font-mono">{step.lease_holder ?? "—"}</span>,
          ],
          ["Lease expires", <TimeText iso={step.lease_expires_at} timeOnly />],
          [
            "Response by",
            <TimeText iso={step.response_deadline_at} timeOnly />,
          ],
          ...(step.compensation_deadline_at
            ? [
                [
                  "Compensation by",
                  <TimeText iso={step.compensation_deadline_at} timeOnly />,
                ] as const,
              ]
            : []),
        ]}
      />
    </Panel>
  );
}

function MetaList({ rows }: { rows: Array<readonly [string, ReactNode]> }) {
  return (
    <dl className="flex flex-col divide-y divide-border/40">
      {rows.map(([k, v], i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-3 py-1.5 text-sm"
        >
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 truncate text-right text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------------------- lower: event log --------------------------- */

function EventLogPanel({ id }: { id: string | undefined }) {
  const events = useEvents(id, { limit: 40 });
  const rows = events.data?.items ?? [];
  return (
    <Panel
      title={<h2>Event log</h2>}
      kicker="audit transitions · newest first"
      bodyClass="p-0"
    >
      <div className="p-5">
        {events.isLoading && <LoadingRows rows={4} />}
        {events.isError && <ErrorState error={events.error} />}
        {!events.isLoading && rows.length === 0 && (
          <EmptyState title="No transitions recorded" />
        )}
      </div>
      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((a) => {
            const tone = workflowStatus(a.to_state).tone;
            return (
              <li
                key={a.seq}
                className="flex items-center gap-2 border-t border-border/40 px-5 py-2 text-xs"
              >
                <span className="font-mono text-muted-foreground">
                  <TimeText iso={a.created_at} timeOnly />
                </span>
                <span
                  className="rounded px-1.5 py-0.5 font-medium"
                  style={{ color: toneVar(tone) }}
                >
                  {a.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {a.from_state
                    ? `${workflowStatus(a.from_state).label} → ${workflowStatus(a.to_state).label}`
                    : workflowStatus(a.to_state).label}
                </span>
                <span className="font-mono text-muted-foreground">
                  {a.reason_code}
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

function ExecMetricsPanel({
  wf,
  updatedAt,
}: {
  wf: Workflow;
  updatedAt: number;
}) {
  const steps = wf.steps;
  const totalAttempts = steps.reduce((a, s) => a + s.active_attempt, 0);
  const compensable = steps.filter((s) => s.compensable).length;
  const wall =
    wf.started_at && wf.finished_at
      ? Date.parse(wf.finished_at) - Date.parse(wf.started_at)
      : null;
  const deadlineLeft = wf.deadline_at
    ? Date.parse(wf.deadline_at) - updatedAt
    : null;
  const metrics = [
    { k: "Steps", v: String(steps.length) },
    { k: "Attempts issued", v: String(totalAttempts) },
    { k: "Compensable", v: String(compensable) },
    { k: "Wall time", v: wall !== null ? humanDuration(wall) : "—" },
    {
      k: "Deadline",
      v:
        deadlineLeft !== null && !TERMINAL.has(wf.state)
          ? deadlineLeft > 0
            ? `${humanDuration(deadlineLeft)} left`
            : "breached"
          : "—",
    },
  ];
  return (
    <Panel
      title={<h2>Execution metrics</h2>}
      kicker="derived from real step data"
    >
      <div className="flex flex-wrap gap-2.5">
        {metrics.map((m) => (
          <div
            key={m.k}
            className="min-w-[124px] flex-1 rounded-lg border border-border/60 bg-chip px-3 py-2"
          >
            <div className="font-mono text-base leading-tight font-semibold break-words text-foreground tabular-nums">
              {m.v}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{m.k}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Host CPU, memory and connection telemetry are{" "}
        <strong className="text-foreground">not exposed</strong> by the engine,
        so they are intentionally absent here rather than simulated.
      </p>
    </Panel>
  );
}

/* ------------------------------- steps table ----------------------------- */

function StepsTable({
  steps,
  onPick,
  chosen,
}: {
  steps: StepView[];
  onPick: (t: string) => void;
  chosen: StepView | null;
}) {
  return (
    <Panel bodyClass="p-0">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="text-xs text-muted-foreground uppercase tracking-wide">
              #
            </TableHead>
            <TableHead className="text-xs text-muted-foreground uppercase tracking-wide">
              Step
            </TableHead>
            <TableHead className="text-xs text-muted-foreground uppercase tracking-wide">
              State
            </TableHead>
            <TableHead className="text-xs text-muted-foreground uppercase tracking-wide">
              Attempts
            </TableHead>
            <TableHead className="text-xs text-muted-foreground uppercase tracking-wide">
              Lease
            </TableHead>
            <TableHead className="text-xs text-muted-foreground uppercase tracking-wide">
              Compensator
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {steps.map((s) => (
            <TableRow
              key={s.step_type}
              className={cn(
                "cursor-pointer",
                chosen?.step_type === s.step_type && "bg-primary/5",
              )}
              onClick={() => onPick(s.step_type)}
            >
              <TableCell className="font-mono tabular-nums">
                {s.position}
              </TableCell>
              <TableCell className="font-mono">{s.step_type}</TableCell>
              <TableCell>
                <StatusBadge state={s.state} kind="step" size="sm" />
              </TableCell>
              <TableCell className="font-mono tabular-nums">
                {s.active_attempt}/{s.max_attempts}
              </TableCell>
              <TableCell className="font-mono text-muted-foreground">
                {s.lease_holder ?? "—"}
              </TableCell>
              <TableCell className="font-mono text-muted-foreground">
                {s.compensator_task ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

/* ------------------------------ attempts tab ----------------------------- */

function AttemptsTab({ id }: { id: string | undefined }) {
  const attempts = useAttempts(id);
  const [loading, error, items] = [
    attempts.isLoading,
    attempts.isError,
    attempts.data ?? [],
  ];
  const view = useMemo(() => buildGantt(items), [items]);
  return (
    <Panel bodyClass="p-5">
      {loading && <LoadingRows rows={4} />}
      {error && (
        <ErrorState error={attempts.error} onRetry={() => attempts.refetch()} />
      )}
      {!loading && !error && items.length === 0 && (
        <EmptyState
          title="No attempts yet"
          hint="Attempts are written the moment a worker claims a step and issues it."
        />
      )}
      {view && (
        <div>
          <div className="flex flex-col gap-1.5">
            {view.rows.map((r, i) => (
              <div
                key={`${r.a.step_type}-${r.a.number}-${i}`}
                className="flex items-center gap-3 text-xs"
              >
                <span className="w-32 shrink-0 truncate font-mono text-foreground">
                  {r.a.step_type}
                </span>
                <span className="w-8 shrink-0 font-mono text-muted-foreground tabular-nums">
                  #{r.a.number}
                </span>
                <span className="relative h-4 min-w-0 flex-1 rounded bg-chip">
                  <span
                    className="absolute inset-y-0 rounded"
                    style={{
                      left: `${r.leftPct}%`,
                      width: `${r.widthPct}%`,
                      background: toneVar(stepStatus(r.a.state).tone),
                    }}
                    title={`${stepStatus(r.a.state).label} · ${humanDuration(r.durationMs)}`}
                  />
                </span>
                <span className="w-16 shrink-0 text-right font-mono text-muted-foreground">
                  {humanDuration(r.durationMs)}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between font-mono text-[11px] text-muted-foreground">
            <span>+0s</span>
            <span>{humanDuration(view.spanMs)}</span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Bands are aligned to a shared origin (earliest attempt start).
            Running attempts are measured to “now”, so their length grows until
            the step settles — durations are read from real started/finished
            timestamps.
          </p>
        </div>
      )}
    </Panel>
  );
}

interface GanttRow {
  a: Attempt;
  leftPct: number;
  widthPct: number;
  durationMs: number;
}

function buildGantt(
  items: Attempt[],
): { rows: GanttRow[]; spanMs: number } | null {
  if (items.length === 0) return null;
  const now = Date.now();
  const starts = items.map((a) => Date.parse(a.started_at));
  const ends = items.map((a) =>
    a.finished_at ? Date.parse(a.finished_at) : now,
  );
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

/* -------------------------------- audit tab ------------------------------ */

function AuditTab({ id }: { id: string | undefined }) {
  const events = useEvents(id, { limit: 50 });
  const rows = events.data?.items ?? [];
  return (
    <Panel bodyClass="p-0">
      <div className="p-5">
        {events.isLoading && <LoadingRows rows={4} />}
        {events.isError && <ErrorState error={events.error} />}
        {!events.isLoading && rows.length === 0 && (
          <EmptyState title="No transitions recorded" />
        )}
      </div>
      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((a) => (
            <li
              key={a.seq}
              className="flex gap-3 border-t border-border/40 px-5 py-3"
            >
              <span className="pt-1.5">
                <span
                  className="block size-2 rounded-full"
                  style={{
                    background: toneVar(workflowStatus(a.to_state).tone),
                  }}
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {a.from_state
                      ? `${workflowStatus(a.from_state).label} → ${workflowStatus(a.to_state).label}`
                      : workflowStatus(a.to_state).label}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {a.reason_code}
                  </span>
                  <StatusBadge state={a.kind} kind="classification" size="sm" />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <TimeText iso={a.created_at} />
                  <span>seq {a.seq}</span>
                  {a.trace_id && (
                    <span className="font-mono">
                      trace {truncate(a.trace_id, 12)}
                    </span>
                  )}
                </div>
                {a.detail != null && (
                  <div className="mt-2">
                    <JsonView value={a.detail} />
                  </div>
                )}
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
    <Panel bodyClass="p-0">
      <div className="p-5">
        {inbound.isLoading && <LoadingRows rows={4} />}
        {inbound.isError && <ErrorState error={inbound.error} />}
        {!inbound.isLoading && rows.length === 0 && (
          <EmptyState
            title="No inbound events correlated"
            hint="Correlated Kafka/outbox events for this workflow will appear here."
          />
        )}
      </div>
      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((e) => (
            <li
              key={e.event_id}
              className="flex gap-3 border-t border-border/40 px-5 py-3"
            >
              <span className="pt-1.5">
                <span
                  className="block size-2 rounded-full"
                  style={{
                    background: toneVar(
                      classificationStatus(e.classification).tone,
                    ),
                  }}
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    state={e.classification ?? ""}
                    kind="classification"
                    size="sm"
                  />
                  {e.step_type && (
                    <span className="text-sm font-medium text-foreground">
                      {e.step_type}
                    </span>
                  )}
                  {e.attempt != null && (
                    <span className="font-mono text-xs text-muted-foreground">
                      attempt {e.attempt}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <TimeText iso={e.received_at} />
                  <CopyChip
                    value={e.event_id}
                    label={truncate(e.event_id, 16)}
                  />
                </div>
                <div className="mt-2">
                  <JsonView value={e.raw} />
                </div>
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
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title={<h2>Instance input</h2>} kicker="workflow.input">
        <JsonView value={wf.input} collapsed={false} />
        <p className="mt-3 text-xs text-st-warn">
          Step <em>outputs</em> are not persisted or exposed by the engine, so
          only the instance input and the frozen definition snapshot are shown.
          Recording per-step output is a documented backend follow-up.
        </p>
      </Panel>
      <Panel title={<h2>Definition snapshot</h2>} kicker="frozen at creation">
        <JsonView value={wf.def_snapshot} collapsed={false} />
        <p className="mt-3 text-xs text-muted-foreground">
          The engine stamps this snapshot when the instance is created, so a
          later re-registration of the definition never rewrites a running
          workflow’s steps.
        </p>
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
      if (cur) {
        cur.count += 1;
        if (e.created_at > cur.last) cur.last = e.created_at;
      } else seen.set(e.trace_id, { count: 1, last: e.created_at });
    }
    return [...seen.entries()];
  }, [events.data]);

  return (
    <Panel bodyClass="p-5">
      {events.isLoading && <LoadingRows rows={3} />}
      {events.isError && <ErrorState error={events.error} />}
      {!events.isLoading && (
        <div>
          <p className="mb-3 text-xs text-muted-foreground">
            There is no distributed-trace backend (gap G7). The identifiers
            below are the real <code className="font-mono">trace_id</code>{" "}
            values the engine already stamped on this workflow’s audit rows —
            shown for correlation, not as a full trace tree.
          </p>
          {traces.length === 0 ? (
            <EmptyState
              title="No trace identifiers stamped"
              hint="Audit rows for this workflow carry no trace_id."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border/40">
              {traces.map(([tid, m]) => (
                <li
                  key={tid}
                  className="flex flex-wrap items-center gap-3 py-2 text-sm"
                >
                  <CopyChip value={tid} label={truncate(tid, 28)} />
                  <span className="text-xs text-muted-foreground">
                    {m.count} event{m.count === 1 ? "" : "s"}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    last <TimeText iso={m.last} timeOnly />
                  </span>
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

function DetailsPanel({
  wf,
  onViewIO,
}: {
  wf: Workflow;
  onViewIO: () => void;
}) {
  const span =
    wf.started_at && wf.finished_at
      ? Date.parse(wf.finished_at) - Date.parse(wf.started_at)
      : null;
  const current =
    wf.steps.find((s) => !DONE.has(s.state)) ?? wf.steps[wf.steps.length - 1];
  return (
    <Panel title={<h2>Workflow details</h2>} kicker="live detail">
      <MetaList
        rows={[
          ["ID", <CopyChip value={wf.id} label={`${truncate(wf.id, 18)}…`} />],
          ["Status", <StatusBadge state={wf.state} />],
          ["Definition", `${wf.def_name} · v${wf.def_version}`],
          [
            "Business key",
            <span className="font-mono">{wf.business_key}</span>,
          ],
          [
            "Current step",
            <span className="font-mono">
              {current ? current.step_type : "—"}
            </span>,
          ],
          [
            "Version",
            <span className="font-mono tabular-nums">{wf.version}</span>,
          ],
          ["Started", <TimeText iso={wf.started_at} />],
          ["Duration", span !== null ? humanDuration(span) : "—"],
          ["Deadline", <TimeText iso={wf.deadline_at} />],
          ["Updated", <RelTime iso={wf.updated_at} />],
        ]}
      />
      <Button variant="outline" size="sm" className="mt-4" onClick={onViewIO}>
        <Braces className="size-3.5" /> View input &amp; definition
      </Button>
    </Panel>
  );
}

/* ------------------------------ action panel ----------------------------- */

function ActionPanel({
  id,
  state,
  version,
}: {
  id: string;
  state: string;
  version: number;
}) {
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
  const retryHint =
    state === "RETRY_WAITING"
      ? "Skips the remaining back-off and re-issues the step now."
      : "Only available while the workflow is RETRY_WAITING.";

  return (
    <Panel
      title={<h2>Operator actions</h2>}
      kicker={`guarded by version ${version}`}
    >
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={cancelDisabled}
          onClick={() => setConfirm("cancel")}
        >
          <CircleSlash className="size-3.5" /> Cancel workflow
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={retryDisabled}
          onClick={() => setConfirm("retry-now")}
        >
          <RefreshCw className="size-3.5" /> Retry now
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {confirm === "retry-now" ? retryHint : cancelHint}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        The engine exposes no pause or priority control, so neither is offered.
        Both verbs send <code className="font-mono">version: {version}</code>;
        if the engine advanced first, the write answers 409 and re-reads before
        you retry.
      </p>

      {confirm && (
        <ConfirmAction
          title={
            confirm === "cancel"
              ? "Cancel this workflow"
              : "Force an immediate retry"
          }
          target={
            <span>
              workflow <code className="font-mono">{truncate(id, 18)}…</code> ·
              currently <StatusBadge state={state} size="sm" />
            </span>
          }
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
                onSuccess: (r) => {
                  toast({
                    tone: "ok",
                    text: `Advanced to ${workflowStatus(r.state).label} @ v${r.version}`,
                  });
                  setConfirm(null);
                },
                onError: () => undefined,
              },
            )
          }
        />
      )}
      <Button asChild variant="ghost" size="sm" className="mt-3">
        <Link to={`/events?workflow=${id}`}>
          <ScrollText className="size-3.5" /> Open full event ledger
        </Link>
      </Button>
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
    <Link
      to="/dlq"
      className={cn(
        "mt-4 flex flex-wrap items-center gap-3 rounded-xl border px-5 py-3 text-sm transition-colors",
        n > 0
          ? "border-st-manual/40 bg-st-manual/5 hover:bg-st-manual/10"
          : "border-border/60 bg-card hover:bg-accent/40",
      )}
    >
      <Inbox
        className={cn(
          "size-4",
          n > 0 ? "text-st-manual" : "text-muted-foreground",
        )}
        aria-hidden="true"
      />
      <span className="font-medium text-foreground">
        Related dead letter / manual interventions
      </span>
      <span
        className="font-mono font-semibold tabular-nums"
        aria-label={`${n} open`}
      >
        {dlq.isLoading ? "…" : n}
      </span>
      {n > 0 && newest && (
        <span
          className="font-mono text-xs text-muted-foreground"
          title={newest.reason_code}
        >
          {newest.class} · {newest.reason_code}
        </span>
      )}
      <span className="ml-auto inline-flex items-center gap-1 text-primary">
        Open centre <ChevronRight className="size-3.5" />
      </span>
    </Link>
  );
}
