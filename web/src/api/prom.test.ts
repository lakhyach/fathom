import { describe, expect, it } from "vitest";

import { byLabel, gaugeValue, parsePrometheus, workflowCensus } from "./prom";

const EXPO = `
# HELP fathom_workflows_total Current workflows by definition and state.
# TYPE fathom_workflows_total gauge
fathom_workflows_total{def_name="booking",state="RUNNING"} 3
fathom_workflows_total{def_name="booking",state="COMPLETED"} 12
fathom_workflows_total{def_name="shipping",state="FAILED_MANUAL"} 1
# HELP fathom_outbox_unpublished_count Rows in the outbox awaiting relay publish.
# TYPE fathom_outbox_unpublished_count gauge
fathom_outbox_unpublished_count 7
# TYPE fathom_events_classified_total counter
fathom_events_classified_total{classification="APPLIED"} 40
fathom_events_classified_total{classification="DUPLICATE"} 5
# TYPE fathom_relay_publish_lag_seconds gauge
fathom_relay_publish_lag_seconds{relay="relay-a"} 0.42
`;

describe("parsePrometheus", () => {
  const map = parsePrometheus(EXPO);

  it("keys families by EXACT sample name (no _count folding that would corrupt outbox gauge)", () => {
    expect(map["fathom_outbox_unpublished_count"]).toBeDefined();
    expect(map["fathom_outbox_unpublished_count"].samples[0].value).toBe(7);
    // a folded parent must NOT exist
    expect(map["fathom_outbox_unpublished"]).toBeUndefined();
  });

  it("captures labels and values for the census", () => {
    const census = workflowCensus(map);
    expect(census).toContainEqual({ def_name: "booking", state: "RUNNING", count: 3 });
    expect(census).toContainEqual({ def_name: "shipping", state: "FAILED_MANUAL", count: 1 });
  });

  it("reads an unlabelled gauge via gaugeValue", () => {
    expect(gaugeValue(map, "fathom_outbox_unpublished_count")).toBe(7);
    expect(gaugeValue(map, "nope_missing")).toBeNull();
  });

  it("splits a family by a label via byLabel, highest first", () => {
    const rows = byLabel(map, "fathom_events_classified_total", "classification");
    expect(rows).toEqual([
      { key: "APPLIED", value: 40 },
      { key: "DUPLICATE", value: 5 },
    ]);
  });

  it("preserves fractional gauge values and the relay label", () => {
    expect(gaugeValue(map, "fathom_relay_publish_lag_seconds", { relay: "relay-a" })).toBeCloseTo(0.42);
  });
});
