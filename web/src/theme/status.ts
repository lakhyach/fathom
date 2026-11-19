/* tokens/status.ts — the ONE place engine states map to visual tokens
   (UI spec §4). Colour never travels alone: every usage co-renders the
   label text, keeping the system colour-blind-safe.
   Deviation recorded in PHASE_6_VALIDATION_REPORT: spec §4 pairs
   COMPENSATING with amber; Fathom renders rollback as violet so the
   reverse lane reads as its own story in the graph — text badges stay
   identical either way. */

export type StatusTone =
  | "completed"
  | "running"
  | "compensating"
  | "negative"
  | "manual"
  | "pending"
  | "warn";

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** true → badge must carry a persistent icon, not colour only (FAILED_MANUAL) */
  icon?: "alert";
}

/** Workflow states — exactly the engine's set (internal/engine). No invented
 *  states; unknown input renders neutral, never crashes the UI. */
const WORKFLOW: Record<string, StatusMeta> = {
  QUEUED: { label: "Queued", tone: "pending" },
  RUNNING: { label: "Running", tone: "running" },
  RETRY_WAITING: { label: "Retry waiting", tone: "warn" },
  COMPENSATING: { label: "Compensating", tone: "compensating" },
  CANCELLING: { label: "Cancelling", tone: "warn" },
  COMPLETED: { label: "Completed", tone: "completed" },
  FAILED: { label: "Failed", tone: "negative" },
  ABORTED: { label: "Aborted", tone: "negative" },
  FAILED_MANUAL: { label: "Failed · manual", tone: "manual", icon: "alert" },
};

/** Step states — engine.StepState set. */
const STEP: Record<string, StatusMeta> = {
  PENDING: { label: "Pending", tone: "pending" },
  ISSUED: { label: "Issued", tone: "running" },
  IN_PROGRESS: { label: "In progress", tone: "running" },
  SUCCEEDED: { label: "Succeeded", tone: "completed" },
  FAILED: { label: "Failed", tone: "negative" },
  TIMED_OUT: { label: "Timed out", tone: "negative" },
  COMPENSATION_PENDING: { label: "Compensation pending", tone: "compensating" },
  COMPENSATING: { label: "Compensating", tone: "compensating" },
  COMPENSATED: { label: "Compensated", tone: "completed" },
  COMPENSATION_FAILED: {
    label: "Compensation failed",
    tone: "manual",
    icon: "alert",
  },
};

/** Attempt states reuse the step vocabulary (SUCCEEDED/FAILED/...). */
const ATTEMPT = STEP;

/** Inbound-event classifications — exactly engine.Classification's set
 *  (DUPLICATE/TERMINAL_IGNORED/UNSOLICITED/STALE/APPLIED/UNPARSEABLE).
 *  The DS-1 visibility window: an ignored event is SHOWN being ignored. */
const CLASSIFICATION: Record<string, StatusMeta> = {
  APPLIED: { label: "Applied", tone: "completed" },
  DUPLICATE: { label: "Duplicate", tone: "warn" },
  STALE: { label: "Stale", tone: "warn" },
  TERMINAL_IGNORED: { label: "Terminal ignored", tone: "pending" },
  UNSOLICITED: { label: "Unsolicited", tone: "negative" },
  UNPARSEABLE: { label: "Unparseable", tone: "negative" },
};

const FALLBACK: StatusMeta = { label: "Unknown", tone: "pending" };

export function workflowStatus(state: string): StatusMeta {
  return WORKFLOW[state] ?? { ...FALLBACK, label: state };
}
export function stepStatus(state: string): StatusMeta {
  return STEP[state] ?? { ...FALLBACK, label: state };
}
export function attemptStatus(state: string): StatusMeta {
  return ATTEMPT[state] ?? { ...FALLBACK, label: state };
}
export function classificationStatus(
  cls: string | null | undefined,
): StatusMeta {
  if (!cls) return FALLBACK;
  return CLASSIFICATION[cls] ?? { ...FALLBACK, label: cls };
}

/** CSS custom property for a tone — components use this, never a literal.
 *  Phase 8: the --st-* ramp carries both the graphic and text role. */
export function toneVar(tone: StatusTone): string {
  return `var(--st-${tone})`;
}

/** Ordered state list for filter chips — mirrors the API's listStates gate. */
export const WORKFLOW_STATES = Object.keys(WORKFLOW);
