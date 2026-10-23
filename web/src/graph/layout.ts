/* Execution-graph layout. The backend provides exactly one ordering fact per
   step — its `position` (declaration order) — plus a `compensator_task` name and
   a `compensable` flag. There is NO depends_on field and NO separate
   compensation node (the step table has one row per forward step). So the honest
   graph is a single left-to-right chain across ascending positions; compensators
   are shown as attributes of their forward step, never as an inferred extra
   vertex (brief §5: "Do not infer an execution path that the backend does not
   provide"). Pure + deterministic so it is golden-testable. */
import { MarkerType, type Edge, type Node } from "@xyflow/react";

import { stepStatus, toneVar } from "../theme/status";
import type { StepView } from "../api/types";

export const NODE_W = 188;
export const NODE_H = 74;
const GAP_X = 74;
const ORIGIN_X = 24;
const ORIGIN_Y = 40;

export interface StepNodeData extends Record<string, unknown> {
  step: StepView;
  index: number;
  selected: boolean;
}

/** Positions are already the declaration order; sort defensively so layout never
 *  depends on the array arriving pre-sorted (the SQL does ORDER BY position). */
export function layoutGraph(steps: StepView[]): { nodes: Node<StepNodeData>[]; edges: Edge[] } {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const nodes: Node<StepNodeData>[] = ordered.map((step, index) => ({
    id: step.step_type,
    type: "step",
    position: { x: ORIGIN_X + index * (NODE_W + GAP_X), y: ORIGIN_Y },
    // dimensions are known a priori (fixed-size cards), so the flow can be fully
    // controlled without React Flow measuring and echoing changes back.
    width: NODE_W,
    height: NODE_H,
    measured: { width: NODE_W, height: NODE_H },
    data: { step, index, selected: false },
  }));

  const edges: Edge[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const target = ordered[i + 1];
    const begun = target.state !== "PENDING";
    const stroke = begun ? toneVar(stepStatus(target.state).tone) : "var(--fx-line-strong)";
    edges.push({
      id: `${ordered[i].step_type}->${target.step_type}`,
      source: ordered[i].step_type,
      target: target.step_type,
      // a gentle bezier reads as the reference's elegant connector; the chain
      // stays strictly left→right because that is the only ordering the engine
      // actually provides (no inferred branches).
      type: "default",
      // an edge is "live" only once the downstream step has actually begun —
      // never painted as traversed for work the backend has not run.
      animated: begun,
      // stroke + arrowhead follow the downstream step's real status tone (the
      // same token the node badge uses), so connector and node never disagree.
      // Unrun work stays a neutral hairline rather than a fake "success" path.
      style: { stroke, strokeWidth: begun ? 2 : 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: stroke },
    });
  }
  return { nodes, edges };
}

export function graphWidth(count: number): number {
  if (count <= 0) return 0;
  return ORIGIN_X * 2 + count * NODE_W + (count - 1) * GAP_X;
}
