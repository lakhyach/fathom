/* Execution-graph layout. The backend provides exactly one ordering fact per
   step — its `position` (declaration order) — plus a `compensator_task` name and
   a `compensable` flag. There is NO depends_on field and NO separate
   compensation node (the step table has one row per forward step). So the honest
   graph is a single left-to-right chain across ascending positions; compensators
   are shown as attributes of their forward step, never as an inferred extra
   vertex (brief §5: "Do not infer an execution path that the backend does not
   provide"). Pure + deterministic so it is golden-testable. */
import type { Edge, Node } from "@xyflow/react";

import type { StepView } from "../api/types";

export const NODE_W = 208;
export const NODE_H = 92;
const GAP_X = 72;
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
    edges.push({
      id: `${ordered[i].step_type}->${ordered[i + 1].step_type}`,
      source: ordered[i].step_type,
      target: ordered[i + 1].step_type,
      // an edge is "live" only once the downstream step has actually begun —
      // never painted as traversed for work the backend has not run.
      animated: ordered[i + 1].state !== "PENDING",
      style: { stroke: "var(--fx-line-strong)", strokeWidth: 1.5 },
    });
  }
  return { nodes, edges };
}

export function graphWidth(count: number): number {
  if (count <= 0) return 0;
  return ORIGIN_X * 2 + count * NODE_W + (count - 1) * GAP_X;
}
