/* Custom execution node. Every field it shows is a real StepView fact: state
   (drives both the tone and the leading glyph), attempt count, live lease claim,
   and compensability. No duration is printed on the node itself — per-step
   durations are not exposed on StepView (only on attempts), so the node defers
   that to the detail rail. Colour never travels alone: the badge text co-renders.

   Phase 8 rebuild: the card is Tailwind; the border/glyph tint, the surface wash
   and the elevation are all the step's real status tone, taken from the same
   TONE map the badges use, so node, connector and pill always tell one story. */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Check,
  Clock,
  KeyRound,
  LoaderCircle,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";

import { stepStatus, toneVar, type StatusTone } from "../theme/status";
import { StatusBadge, TONE } from "../components/ui";
import { cn } from "@/lib/utils";
import { NODE_H, NODE_W, type StepNodeData } from "./layout";
import "./graph.css";

type StepFlowNode = Node<StepNodeData>;

function statusGlyph(tone: StatusTone) {
  const cls = "size-3.5";
  switch (tone) {
    case "completed":
      return <Check className={cls} />;
    case "running":
      return <LoaderCircle className={cn(cls, "animate-spin")} />;
    case "compensating":
      return <Undo2 className={cls} />;
    case "negative":
      return <X className={cls} />;
    case "manual":
    case "warn":
      return <TriangleAlert className={cls} />;
    default:
      return <Clock className={cls} />;
  }
}

export function StepNode({ data }: NodeProps<StepFlowNode>) {
  const { step, selected } = data;
  const meta = stepStatus(step.state);
  const running = step.state === "ISSUED" || step.state === "IN_PROGRESS";
  const compensating = step.state.startsWith("COMPENSAT");
  const tone = toneVar(meta.tone);
  const t = TONE[meta.tone];
  return (
    <div
      className={cn(
        "relative flex flex-col justify-between gap-2 overflow-hidden rounded-[15px] border bg-card p-3 text-card-foreground transition-colors",
        t.glow,
        running && "flow-node--running",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-canvas",
      )}
      style={{ width: NODE_W, height: NODE_H, borderColor: tone }}
      data-step={step.step_type}
    >
      <span
        className={cn("pointer-events-none absolute inset-0", t.soft)}
        aria-hidden="true"
      />
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-b from-white/14 to-transparent"
        aria-hidden="true"
      />
      {/* Every side a connector can legitimately join, named so layout.ts can
          route across a row or down a fold. graph.css keeps handles at zero
          opacity, so this is wiring, not ornament. */}
      <Handle type="target" position={Position.Left} id="in-l" />
      <Handle type="target" position={Position.Right} id="in-r" />
      <Handle type="target" position={Position.Top} id="in-t" />
      <Handle type="source" position={Position.Right} id="out-r" />
      <Handle type="source" position={Position.Left} id="out-l" />
      <Handle type="source" position={Position.Bottom} id="out-b" />

      <div className="relative flex min-w-0 items-center gap-2">
        <span
          className="grid size-6 shrink-0 place-items-center rounded-full border"
          style={{ color: tone, borderColor: tone }}
          aria-hidden="true"
        >
          {statusGlyph(meta.tone)}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold"
          title={step.step_type}
        >
          {step.step_type}
        </span>
        {step.compensable && (
          <span
            className="shrink-0 text-st-compensating"
            title={
              step.compensator_task
                ? `compensates via ${step.compensator_task}`
                : "compensable"
            }
          >
            <Undo2 className="size-3" />
          </span>
        )}
        {compensating && (
          <span className="shrink-0 rounded-full border border-st-compensating/40 bg-st-compensating/10 px-1.5 text-[10px] font-semibold text-st-compensating">
            rolling back
          </span>
        )}
      </div>

      <div className="relative flex items-center gap-2 text-[11px] text-muted-foreground">
        <StatusBadge state={step.state} kind="step" size="sm" />
        <span
          className="rounded-full border border-border/60 bg-chip px-1.5 font-mono tabular-nums"
          title="active attempt / max attempts"
        >
          {step.active_attempt}/{step.max_attempts}
        </span>
        {running && step.lease_holder && (
          <span
            className="inline-flex items-center text-st-running"
            title={`lease held by ${step.lease_holder}`}
          >
            <KeyRound className="size-3" />
          </span>
        )}
      </div>
    </div>
  );
}
