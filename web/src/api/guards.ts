/* Consistent response validation (brief §6). No schema library — small
   honest guards that fail loudly as MalformedResponseError when the server
   shape drifts from types.ts, instead of letting `undefined` leak into UI. */
import type {
  ActionResult,
  Attempt,
  AuditEvent,
  DeadLetter,
  Definition,
  InboundEvent,
  Page,
  Readyz,
  ResolveResult,
  StepView,
  Workflow,
  WorkflowSummary,
} from "./types";
import { MalformedResponseError } from "./errors";

type V = Record<string, unknown>;

const isObj = (x: unknown): x is V =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const isStrOpt = (x: unknown): boolean =>
  x === null || x === undefined || isStr(x);
const isNumOpt = (x: unknown): boolean =>
  x === null || x === undefined || isNum(x);

function req(o: V, key: string, what: string): unknown {
  if (!(key in o))
    throw new MalformedResponseError(`${what} (missing "${key}")`);
  return o[key];
}

export function vWorkflow(x: unknown, what = "workflow"): Workflow {
  if (!isObj(x)) throw new MalformedResponseError(what);
  req(x, "id", what);
  req(x, "steps", what);
  if (
    !isStr(x.id) ||
    !isStr(x.state) ||
    !isNum(x.version) ||
    !Array.isArray(x.steps)
  ) {
    throw new MalformedResponseError(`${what} (id/state/version/steps types)`);
  }
  for (const s of x.steps) vStep(s);
  return x as unknown as Workflow;
}

export function vWorkflowSummary(
  x: unknown,
  _what = "workflow summary",
): WorkflowSummary {
  if (
    !isObj(x) ||
    !isStr(x.id) ||
    !isStr(x.state) ||
    !isNum(x.version) ||
    !isStr(x.business_key) ||
    !isStr(x.created_at)
  ) {
    throw new MalformedResponseError("workflow summary");
  }
  return x as unknown as WorkflowSummary;
}

function vStep(x: unknown): StepView {
  if (
    !isObj(x) ||
    !isStr(x.step_type) ||
    !isNum(x.position) ||
    !isStr(x.state) ||
    !isBool(x.compensable)
  ) {
    throw new MalformedResponseError("workflow.steps[]");
  }
  return x as unknown as StepView;
}

export function vPage<T>(
  x: unknown,
  what: string,
  item: (v: unknown, w: string) => T,
): Page<T> {
  if (!isObj(x) || !("items" in x))
    throw new MalformedResponseError(`${what} (items[])`);
  // A Go nil slice marshals to JSON null — an honest empty page, not shape
  // drift. Only a non-array, non-null `items` is a real contract violation.
  const raw = x["items"];
  if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
    throw new MalformedResponseError(`${what} (items[])`);
  }
  const items = (Array.isArray(raw) ? raw : []).map((i) =>
    item(i, `${what}.item`),
  );
  const nc = x["next_cursor"];
  if (!isStrOpt(nc)) throw new MalformedResponseError(`${what} (next_cursor)`);
  return { items, next_cursor: typeof nc === "string" ? nc : null };
}

export function vAudit(x: unknown): AuditEvent {
  if (
    !isObj(x) ||
    !isNum(x.seq) ||
    !isStr(x.kind) ||
    !isStr(x.to_state) ||
    !isStr(x.reason_code) ||
    !isStr(x.created_at)
  ) {
    throw new MalformedResponseError("audit item");
  }
  if (!isStrOpt(x.from_state) || !isStrOpt(x.trace_id))
    throw new MalformedResponseError("audit item (nullables)");
  return x as unknown as AuditEvent;
}

export function vInbound(x: unknown): InboundEvent {
  if (!isObj(x) || !isStr(x.event_id) || !isStr(x.received_at))
    throw new MalformedResponseError("inbound item");
  if (
    !isStrOpt(x.step_type) ||
    !isNumOpt(x.attempt) ||
    !isStrOpt(x.classification)
  ) {
    throw new MalformedResponseError("inbound item (nullables)");
  }
  return x as unknown as InboundEvent;
}

export function vAttempt(x: unknown): Attempt {
  if (
    !isObj(x) ||
    !isStr(x.step_type) ||
    !isNum(x.number) ||
    !isStr(x.state) ||
    !isStr(x.started_at)
  ) {
    throw new MalformedResponseError("attempt item");
  }
  if (!isStrOpt(x.error_class) || !isStrOpt(x.finished_at))
    throw new MalformedResponseError("attempt item (nullables)");
  return x as unknown as Attempt;
}

export function vDeadLetter(x: unknown): DeadLetter {
  if (
    !isObj(x) ||
    !isStr(x.id) ||
    !isStr(x.workflow_id) ||
    !isStr(x.class) ||
    !isStr(x.reason_code) ||
    !isStr(x.created_at)
  ) {
    throw new MalformedResponseError("dead-letter item");
  }
  return x as unknown as DeadLetter;
}

export function vDefinition(x: unknown): Definition {
  if (
    !isObj(x) ||
    !isStr(x.name) ||
    !isNum(x.version) ||
    !isStr(x.status) ||
    !Array.isArray(x.steps)
  ) {
    throw new MalformedResponseError("definition");
  }
  for (const s of x.steps) {
    if (!isObj(s) || !isStr(s["type"]))
      throw new MalformedResponseError("definition.steps[]");
  }
  return x as unknown as Definition;
}

export function vActionResult(x: unknown): ActionResult {
  if (!isObj(x) || !isStr(x.id) || !isStr(x.state) || !isNum(x.version))
    throw new MalformedResponseError("action result");
  return x as unknown as ActionResult;
}

export function vResolveResult(x: unknown): ResolveResult {
  if (
    !isObj(x) ||
    !isStr(x.dead_letter_id) ||
    !isStr(x.workflow_id) ||
    !isStr(x.state) ||
    !isNum(x.version) ||
    !isBool(x.dry_run)
  ) {
    throw new MalformedResponseError("resolve result");
  }
  return x as unknown as ResolveResult;
}

export function vReadyz(x: unknown): Readyz {
  if (!isObj(x) || (x.status !== "ready" && x.status !== "unavailable"))
    throw new MalformedResponseError("readyz");
  return x as unknown as Readyz;
}

/** problem+json sniff (DS-13): type/title/status/code all present as strings/numbers. */
export function looksLikeProblem(x: unknown): boolean {
  return (
    isObj(x) &&
    isStr(x.type) &&
    isStr(x.title) &&
    isNum(x.status) &&
    isStr(x.code)
  );
}
