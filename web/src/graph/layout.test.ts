import { describe, expect, it } from "vitest";

import { columnsFor, graphSpan, layoutGraph, NODE_W } from "../graph/layout";
import type { StepView } from "../api/types";

function step(
  partial: Partial<StepView> & { step_type: string; position: number },
): StepView {
  return {
    state: "PENDING",
    active_attempt: 0,
    max_attempts: 1,
    compensable: false,
    lease_holder: null,
    lease_expires_at: null,
    response_deadline_at: null,
    compensation_deadline_at: null,
    compensator_task: null,
    ...partial,
  } as StepView;
}

describe("layoutGraph", () => {
  it("lays a sequential chain left→right by position, edges between consecutive steps", () => {
    const steps = [
      step({ step_type: "reserve", position: 0, state: "SUCCEEDED" }),
      step({
        step_type: "charge",
        position: 1,
        state: "IN_PROGRESS",
        compensable: true,
        compensator_task: "refund",
      }),
      step({ step_type: "notify", position: 2, state: "PENDING" }),
    ];
    const { nodes, edges } = layoutGraph(steps);

    expect(nodes.map((n) => n.id)).toEqual(["reserve", "charge", "notify"]);
    expect(nodes[0].position.x).toBeLessThan(nodes[1].position.x);
    expect(nodes[1].position.x - nodes[0].position.x).toBeGreaterThan(NODE_W); // no overlap
    expect(nodes.every((n) => n.position.y === nodes[0].position.y)).toBe(true);

    expect(edges.map((e) => e.id)).toEqual([
      "reserve->charge",
      "charge->notify",
    ]);
    // compensation is an ATTRIBUTE of charge, never a separate vertex (§5 honesty)
    expect(nodes.find((n) => n.id === "refund")).toBeUndefined();
  });

  it("sorts defensively when the array arrives out of declaration order", () => {
    const { nodes, edges } = layoutGraph([
      step({ step_type: "c", position: 2 }),
      step({ step_type: "a", position: 0 }),
      step({ step_type: "b", position: 1 }),
    ]);
    expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(edges.map((e) => e.source)).toEqual(["a", "b"]);
  });

  it("marks an edge live only once its downstream step has begun", () => {
    const { edges } = layoutGraph([
      step({ step_type: "a", position: 0, state: "SUCCEEDED" }),
      step({ step_type: "b", position: 1, state: "PENDING" }),
      step({ step_type: "c", position: 2, state: "ISSUED" }),
    ]);
    expect(edges.find((e) => e.id === "a->b")?.animated).toBe(false); // b not started
    expect(edges.find((e) => e.id === "b->c")?.animated).toBe(true); // c has begun
  });

  it("emits no edges for a single-step workflow", () => {
    const { nodes, edges } = layoutGraph([
      step({ step_type: "only", position: 0 }),
    ]);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });
});

/* Long chains fold so the inspector can frame the whole saga at once. The fold
   must never reorder the chain — position is still the only ordering fact. */
describe("serpentine folding", () => {
  const seven = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((s, i) =>
    step({ step_type: s, position: i }),
  );

  it("keeps four steps or fewer on one row", () => {
    expect(columnsFor(4)).toBe(4);
    const { nodes } = layoutGraph(seven.slice(0, 4), columnsFor(4));
    expect(new Set(nodes.map((n) => n.position.y)).size).toBe(1);
  });

  it("folds seven into two balanced rows in declaration order", () => {
    const cols = columnsFor(7);
    expect(cols).toBe(4);
    const { nodes } = layoutGraph(seven, cols);
    expect(nodes.map((n) => n.id)).toEqual(seven.map((s) => s.step_type));
    const rows = [...new Set(nodes.map((n) => n.position.y))].sort(
      (a, b) => a - b,
    );
    expect(rows).toHaveLength(2);
    // the fold drops straight down: step 5 sits directly beneath step 4
    expect(nodes[4].position.x).toBe(nodes[3].position.x);
    expect(nodes[4].position.y).toBeGreaterThan(nodes[3].position.y);
    // ...and row 2 runs right→left, so the chain never flies back across the canvas
    expect(nodes[5].position.x).toBeLessThan(nodes[4].position.x);
  });

  it("routes the fold connector bottom→top and in-row connectors side→side", () => {
    const { edges } = layoutGraph(seven, columnsFor(7));
    expect(edges.find((e) => e.id === "s4->s5")).toMatchObject({
      sourceHandle: "out-b",
      targetHandle: "in-t",
    });
    expect(edges.find((e) => e.id === "s1->s2")).toMatchObject({
      sourceHandle: "out-r",
      targetHandle: "in-l",
    });
    expect(edges.find((e) => e.id === "s5->s6")).toMatchObject({
      sourceHandle: "out-l",
      targetHandle: "in-r",
    });
  });

  it("reports a content box that grows with the row count", () => {
    expect(graphSpan(4, columnsFor(4)).h).toBeLessThan(
      graphSpan(7, columnsFor(7)).h,
    );
    expect(graphSpan(0, 1)).toEqual({ w: 0, h: 0 });
  });
});
