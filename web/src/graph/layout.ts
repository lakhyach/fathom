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

export const NODE_W = 238;
export const NODE_H = 88;
const GAP_X = 84;
const GAP_Y = 52;
export const ORIGIN_X = 24;
export const ORIGIN_Y = 40;

/* A chain longer than a stageful wraps into two serpentine rows so the operator
   still reads WHERE the failure sits in the whole saga — the honest ordering is
   unchanged, only the drawing folds. Serpentine (row 2 runs right→left) keeps the
   wrap connector a short vertical drop instead of a line flying back across the
   canvas. */
export function columnsFor(count: number): number {
  return count <= 4 ? Math.max(count, 1) : Math.ceil(count / 2);
}

/** Content box of the wrapped chain, in flow coordinates. */
export function graphSpan(
  count: number,
  columns: number,
): { w: number; h: number } {
  if (count <= 0) return { w: 0, h: 0 };
  const cols = Math.max(1, Math.min(columns, count));
  const rows = Math.ceil(count / cols);
  return {
    w: ORIGIN_X * 2 + cols * NODE_W + (cols - 1) * GAP_X,
    h: ORIGIN_Y * 2 + rows * NODE_H + (rows - 1) * GAP_Y,
  };
}

export interface StepNodeData extends Record<string, unknown> {
  step: StepView;
  index: number;
  selected: boolean;
}

/** Positions are already the declaration order; sort defensively so layout never
 *  depends on the array arriving pre-sorted (the SQL does ORDER BY position). */
export function layoutGraph(
  steps: StepView[],
  columns = steps.length,
): { nodes: Node<StepNodeData>[]; edges: Edge[] } {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const cols = Math.max(1, Math.min(columns, ordered.length));
  const nodes: Node<StepNodeData>[] = ordered.map((step, index) => {
    const row = Math.floor(index / cols);
    const slot = index % cols;
    const col = row % 2 === 0 ? slot : cols - 1 - slot;
    return {
      id: step.step_type,
      type: "step",
      position: {
        x: ORIGIN_X + col * (NODE_W + GAP_X),
        y: ORIGIN_Y + row * (NODE_H + GAP_Y),
      },
      // dimensions are known a priori (fixed-size cards), so the flow can be fully
      // controlled without React Flow measuring and echoing changes back.
      width: NODE_W,
      height: NODE_H,
      measured: { width: NODE_W, height: NODE_H },
      data: { step, index, selected: false },
    };
  });

  const edges: Edge[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const target = ordered[i + 1];
    const begun = target.state !== "PENDING";
    const stroke = begun
      ? toneVar(stepStatus(target.state).tone)
      : "var(--border)";
    const row = Math.floor(i / cols);
    const wraps = Math.floor(i / cols) !== Math.floor((i + 1) / cols);
    // Which pair of handles a connector joins is a layout fact, not a style:
    // across a row it runs between the facing sides, and at a fold it drops down.
    const route = wraps
      ? { sourceHandle: "out-b", targetHandle: "in-t" }
      : row % 2 === 0
        ? { sourceHandle: "out-r", targetHandle: "in-l" }
        : { sourceHandle: "out-l", targetHandle: "in-r" };
    edges.push({
      id: `${ordered[i].step_type}->${target.step_type}`,
      source: ordered[i].step_type,
      target: target.step_type,
      ...route,
      // a gentle bezier reads as the reference's elegant connector; the chain
      // stays strictly ordered because position is the only ordering the engine
      // actually provides (no inferred branches).
      type: "default",
      // an edge is "live" only once the downstream step has actually begun —
      // never painted as traversed for work the backend has not run.
      animated: begun,
      // stroke + arrowhead follow the downstream step's real status tone (the
      // same token the node badge uses), so connector and node never disagree.
      // Unrun work stays a neutral hairline rather than a fake "success" path —
      // and it is dashed, so an unreadable faint line at fit zoom still reads as
      // "not executed yet" rather than looking like a drawn traversal.
      style: {
        stroke,
        strokeWidth: begun ? 2 : 1.5,
        strokeDasharray: begun ? undefined : "5 6",
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 15,
        height: 15,
        color: stroke,
      },
    });
  }
  return { nodes, edges };
}
