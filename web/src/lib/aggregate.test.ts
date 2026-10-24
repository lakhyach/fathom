import { describe, expect, it } from "vitest";

import {
  bucketLabel,
  bucketPlacements,
  definitionLedger,
  outcomeOf,
  outcomeSplit,
  percentile,
  wallTimes,
} from "./aggregate";
import type { WorkflowSummary } from "../api/types";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

function row(over: Partial<WorkflowSummary> & { id: string }): WorkflowSummary {
  return {
    def_name: "booking",
    def_version: 1,
    state: "COMPLETED",
    version: 3,
    business_key: over.id,
    deadline_at: new Date(NOW + 60_000).toISOString(),
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    finished_at: new Date(NOW).toISOString(),
    ...over,
  } as WorkflowSummary;
}

describe("outcomeOf", () => {
  it("splits the engine's states into completed, negative and open", () => {
    expect(outcomeOf("COMPLETED")).toBe("completed");
    expect(outcomeOf("FAILED")).toBe("negative");
    expect(outcomeOf("ABORTED")).toBe("negative");
    expect(outcomeOf("FAILED_MANUAL")).toBe("negative");
    expect(outcomeOf("RUNNING")).toBe("open");
    expect(outcomeOf("COMPENSATING")).toBe("open");
  });
});

describe("bucketPlacements", () => {
  const bucket = 2 * 3600_000;
  const range = 24 * 3600_000;

  it("buckets rows by created_at and counts each outcome lane", () => {
    const rows = [
      row({
        id: "a",
        state: "COMPLETED",
        created_at: new Date(NOW - 30 * 60_000).toISOString(),
      }),
      row({
        id: "b",
        state: "FAILED",
        created_at: new Date(NOW - 30 * 60_000).toISOString(),
      }),
      row({
        id: "c",
        state: "RUNNING",
        created_at: new Date(NOW - 90 * 60_000).toISOString(),
      }),
    ];
    const buckets = bucketPlacements(rows, {
      rangeMs: range,
      bucketMs: bucket,
      now: NOW,
    });
    expect(buckets).toHaveLength(12);
    expect(buckets.reduce((a, b) => a + b.total, 0)).toBe(3);
    expect(buckets.reduce((a, b) => a + b.completed, 0)).toBe(1);
    expect(buckets.reduce((a, b) => a + b.negative, 0)).toBe(1);
    expect(buckets.reduce((a, b) => a + b.open, 0)).toBe(1);
  });

  it("drops rows outside the window instead of clamping them into the edge", () => {
    const rows = [
      row({
        id: "old",
        created_at: new Date(NOW - 40 * 3600_000).toISOString(),
      }),
    ];
    const buckets = bucketPlacements(rows, {
      rangeMs: range,
      bucketMs: bucket,
      now: NOW,
    });
    expect(buckets.every((b) => b.total === 0)).toBe(true);
  });

  it("keeps an open workflow out of the terminal lanes", () => {
    const buckets = bucketPlacements(
      [
        row({
          id: "q",
          state: "QUEUED",
          created_at: new Date(NOW - 60_000).toISOString(),
        }),
      ],
      {
        rangeMs: range,
        bucketMs: bucket,
        now: NOW,
      },
    );
    expect(buckets.reduce((a, b) => a + b.open, 0)).toBe(1);
    expect(buckets.reduce((a, b) => a + b.completed + b.negative, 0)).toBe(0);
  });
});

describe("bucketLabel", () => {
  it("shows clock time inside a day and calendar dates beyond it", () => {
    expect(bucketLabel(NOW, 24 * 3600_000, true)).toBe("12:00");
    expect(bucketLabel(NOW, 7 * 24 * 3600_000, true)).toBe("24 Oct");
  });
});

describe("wallTimes", () => {
  it("measures created_at to finished_at and ignores still-open rows", () => {
    const items = wallTimes([
      row({ id: "a", finished_at: new Date(NOW + 1500).toISOString() }),
      row({ id: "open", finished_at: null }),
      row({ id: "bad", finished_at: new Date(NOW - 5000).toISOString() }),
    ]);
    expect(items.map((i) => i.ms)).toEqual([1500]);
    expect(items[0].label).toBe("booking · a");
  });
});

describe("percentile", () => {
  it("takes the nearest rank of the real sample", () => {
    expect(percentile([10, 30, 20], 50)).toBe(20);
    expect(percentile([10, 30, 20], 95)).toBe(30);
  });

  it("returns null for an empty sample rather than zero", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("outcomeSplit", () => {
  it("reports a success rate only when something has actually finished", () => {
    expect(
      outcomeSplit([
        row({ id: "a", state: "COMPLETED" }),
        row({ id: "b", state: "FAILED" }),
      ]).successRate,
    ).toBe(0.5);
    expect(
      outcomeSplit([row({ id: "c", state: "RUNNING" })]).successRate,
    ).toBeNull();
  });
});

describe("definitionLedger", () => {
  it("ranks definitions by total placements and splits each by outcome", () => {
    const ledger = definitionLedger([
      { def_name: "echo-single", state: "COMPLETED", count: 3 },
      { def_name: "echo-compensate", state: "ABORTED", count: 2 },
      { def_name: "loop-test", state: "FAILED_MANUAL", count: 1 },
      { def_name: "echo-compensate", state: "RUNNING", count: 1 },
    ]);
    expect(ledger.map((l) => l.name)).toEqual([
      "echo-compensate",
      "echo-single",
      "loop-test",
    ]);
    expect(ledger[0]).toEqual({
      name: "echo-compensate",
      total: 3,
      completed: 0,
      negative: 2,
      open: 1,
    });
  });
});
