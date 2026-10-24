/* Wire types — a faithful mirror of the Go API DTOs (internal/api/dto.go,
   handlers.go, health.go) as VERIFIED against the Phase 5 implementation.
   There is no OpenAPI document yet (gap G6): these types are the cockpit's
   contract, kept honest by the runtime validators in guards.ts and the
   contract tests. Field names are snake_case exactly as served. */

/* ---------- workflow ---------- */

export interface StepView {
  step_type: string;
  position: number;
  state: string;
  active_attempt: number;
  max_attempts: number;
  compensable: boolean;
  lease_holder: string | null;
  lease_expires_at: string | null;
  response_deadline_at: string | null;
  compensation_deadline_at: string | null;
  compensator_task: string | null;
}

/** GET /workflows rows are SUMMARIES (store.WorkflowSummary): no input,
 *  no def_snapshot, no steps — only the detail endpoint carries the full row. */
export interface WorkflowSummary {
  id: string;
  def_name: string;
  def_version: number;
  state: string;
  version: number;
  business_key: string;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface Workflow {
  id: string;
  def_name: string;
  def_version: number;
  /** stored step document: wireDefStep[] — see DefinitionStep below */
  def_snapshot: unknown;
  state: string;
  version: number;
  business_key: string;
  input: unknown;
  deadline_at: string;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  steps: StepView[];
}

/** wireDefStep (definitions.go): the only layout the backend provides —
 *  a sequential list; there is no depends_on and no position field. */
export interface DefinitionStep {
  type: string;
  max_attempts?: number;
  compensable?: boolean;
  compensator_task?: string;
  forward_timeout_secs?: number;
}

/* ---------- audit / events ---------- */

export interface AuditEvent {
  seq: number;
  kind: string; // TRANSITION | EVENT_CLASSIFIED | DEADLETTER | OPERATOR_ACTION
  from_state: string | null;
  to_state: string;
  reason_code: string;
  detail: unknown;
  trace_id: string | null;
  created_at: string;
}

export interface InboundEvent {
  event_id: string;
  step_type: string | null;
  attempt: number | null;
  received_at: string;
  classification: string | null;
  raw: unknown;
}

export interface Attempt {
  step_type: string;
  number: number;
  state: string;
  error_class: string | null;
  error_detail: unknown;
  started_at: string;
  finished_at: string | null;
}

/* ---------- dead letters ---------- */

export interface DeadLetter {
  id: string;
  workflow_id: string;
  step_type: string | null;
  attempt: number | null;
  class: string;
  reason_code: string;
  detail: unknown;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
}

/* ---------- definitions ---------- */

export interface Definition {
  name: string;
  version: number;
  status: string; // ACTIVE | RETIRED
  steps: DefinitionStep[];
  created_at: string;
}

/* ---------- envelopes & actions ---------- */

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** actionResult (handlers.go) — the durable verdict of cancel / retry-now. */
export interface ActionResult {
  id: string;
  state: string;
  version: number;
}

/** resolve response (handlers.go): preview when dry_run was requested. */
export interface ResolveResult {
  dead_letter_id: string;
  workflow_id: string;
  state: string;
  version: number;
  dry_run: boolean;
}

export interface Healthz {
  status: "ok";
}

export interface Readyz {
  status: "ready" | "unavailable";
  reason?: "db_unavailable" | "relay_lag";
}

/* ---------- problem+json (DS-13) ---------- */

export interface FieldError {
  field: string;
  rule: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string; // stable machine code: MALFORMED_JSON, CONFLICT_RETRY, ...
  trace_id: string;
  instance: string;
  detail?: string;
  errors?: FieldError[];
  version?: number; // carried on 409 CONFLICT_RETRY
  [extra: string]: unknown;
}
