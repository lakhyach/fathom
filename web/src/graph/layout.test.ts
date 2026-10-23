import { describe, expect, it } from "vitest";

import { layoutGraph, NODE_W } from "../graph/layout";
import type { StepView } from "../api/types";

function step(partial: Partial<StepView> & { step_type: string; position: number }): StepView {
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
      step({ step_type: "charge", position: 1, state: "IN_PROGRESS", compensable: true, compensator_task: "refund" }),
      step({ step_type: "notify", position: 2, state: "PENDING" }),
    ];
    const { nodes, edges } = layoutGraph(steps);

    expect(nodes.map((n) => n.id)).toEqual(["reserve", "charge", "notify"]);
    expect(nodes[0].position.x).toBeLessThan(nodes[1].position.x);
    expect(nodes[1].position.x - nodes[0].position.x).toBeGreaterThan(NODE_W); // no overlap
    expect(nodes.every((n) => n.position.y === nodes[0].position.y)).toBe(true);

    expect(edges.map((e) => e.id)).toEqual(["reserve->charge", "charge->notify"]);
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
    const { nodes, edges } = layoutGraph([step({ step_type: "only", position: 0 })]);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });
});
