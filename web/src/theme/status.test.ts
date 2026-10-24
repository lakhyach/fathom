import { describe, expect, it } from "vitest";

import {
  WORKFLOW_STATES,
  attemptStatus,
  classificationStatus,
  stepStatus,
  toneVar,
  workflowStatus,
} from "./status";

describe("status mapping (single source of truth)", () => {
  it("covers the nine engine workflow states in order", () => {
    expect(WORKFLOW_STATES).toEqual([
      "QUEUED", "RUNNING", "RETRY_WAITING", "COMPENSATING", "CANCELLING",
      "COMPLETED", "FAILED", "ABORTED", "FAILED_MANUAL",
    ]);
  });

  it("pairs FAILED_MANUAL with a persistent alert icon (never colour alone)", () => {
    expect(workflowStatus("FAILED_MANUAL").icon).toBe("alert");
    expect(workflowStatus("COMPENSATING").icon).toBeUndefined();
    expect(stepStatus("COMPENSATION_FAILED").icon).toBe("alert");
  });

  it("renders the real classifications, not invented ones", () => {
    expect(classificationStatus("TERMINAL_IGNORED").label).toBe("Terminal ignored");
    expect(classificationStatus("UNPARSEABLE").tone).toBe("negative");
    expect(attemptStatus("SUCCEEDED").tone).toBe("completed");
  });

  it("degrades unknown states to a neutral badge that still shows the raw label", () => {
    const meta = workflowStatus("SOME_NEW_STATE");
    expect(meta.label).toBe("SOME_NEW_STATE");
    expect(meta.tone).toBe("pending");
  });

  it("exposes a token per tone (components never hard-code colour)", () => {
    expect(toneVar("compensating")).toBe("var(--st-compensating)");
  });
});
