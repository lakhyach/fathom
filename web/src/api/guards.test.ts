import { describe, expect, it } from "vitest";

import { MalformedResponseError } from "./errors";
import {
  vDeadLetter,
  vPage,
  vReadyz,
  vResolveResult,
  vWorkflow,
  vWorkflowSummary,
} from "./guards";

const summary = {
  id: "018f", def_name: "booking", def_version: 2, state: "RUNNING", version: 3,
  business_key: "order-1", deadline_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", finished_at: null,
};

describe("response guards", () => {
  it("accepts a well-formed summary row", () => {
    expect(vWorkflowSummary(summary).id).toBe("018f");
  });

  it("rejects a summary missing business_key (would silently break the list)", () => {
    const { business_key: _drop, ...rest } = summary;
    expect(() => vWorkflowSummary(rest)).toThrow(MalformedResponseError);
  });

  it("vWorkflow requires the steps array that only the detail endpoint serves", () => {
    expect(() => vWorkflow({ id: "x", state: "RUNNING", version: 1 })).toThrow(MalformedResponseError);
    const detail = {
      id: "x", state: "RUNNING", version: 1, business_key: "k", def_name: "d", def_version: 1,
      def_snapshot: {}, input: {}, deadline_at: "z", next_attempt_at: null,
      created_at: "z", updated_at: "z", started_at: null, finished_at: null,
      steps: [{ step_type: "a", position: 0, state: "PENDING", active_attempt: 0, max_attempts: 1, compensable: false }],
    };
    expect(vWorkflow(detail).steps[0].step_type).toBe("a");
  });

  it("normalises a missing next_cursor to null and validates items", () => {
    const page = vPage({ items: [summary] }, "workflows", vWorkflowSummary);
    expect(page.next_cursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(() => vPage({ items: [{ id: "x" }] }, "workflows", vWorkflowSummary)).toThrow(MalformedResponseError);
  });

  it("treats a Go nil slice (items:null) as an honest empty page, not shape drift", () => {
    // GET /v1/workflows?business_key=<miss> answers {"items":null,"next_cursor":null}.
    const empty = vPage({ items: null, next_cursor: null }, "workflows", vWorkflowSummary);
    expect(empty.items).toEqual([]);
    expect(empty.next_cursor).toBeNull();
    // a non-array, non-null items is still a contract violation.
    expect(() => vPage({ items: 42 }, "workflows", vWorkflowSummary)).toThrow(MalformedResponseError);
  });

  it("accepts ready/unavailable readyz, rejects a stray status", () => {
    expect(vReadyz({ status: "unavailable", reason: "relay_lag" }).reason).toBe("relay_lag");
    expect(() => vReadyz({ status: "weird" })).toThrow(MalformedResponseError);
  });

  it("requires dry_run boolean on a resolve result", () => {
    expect(() => vResolveResult({ dead_letter_id: "d", workflow_id: "w", state: "FAILED", version: 2 })).toThrow(MalformedResponseError);
    expect(vResolveResult({ dead_letter_id: "d", workflow_id: "w", state: "FAILED", version: 2, dry_run: true }).dry_run).toBe(true);
  });

  it("dead letter needs the stable class + reason code", () => {
    expect(() => vDeadLetter({ id: "1", workflow_id: "w", class: "X" })).toThrow(MalformedResponseError);
    expect(vDeadLetter({ id: "1", workflow_id: "w", class: "UNSOLICITED_EVENT", reason_code: "NO_STEP", created_at: "z" }).class).toBe("UNSOLICITED_EVENT");
  });
});
