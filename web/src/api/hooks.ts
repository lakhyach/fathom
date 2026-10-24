/* Query layer. No SSE exists server-side (gap G1), so liveness is bounded
   polling: detail views 3 s while the workflow is open, lists 8 s, infra
   probes 10 s, metrics 15 s — comfortably under the 100/min/key budget,
   and paused the moment data reaches a terminal state. Screens surface
   `dataUpdatedAt` as "snapshot @ ts" — never a fake "live" badge
   (UI spec §3.5 rule 4). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../state/api";
import {
  ApiError,
  AuthError,
  ConflictError,
  ConnectionError,
  RateLimitError,
} from "./errors";
import { parsePrometheus, type MetricMap } from "./prom";
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
  Workflow,
  WorkflowSummary,
} from "./types";
import type {
  Endpoints,
  ListDlqParams,
  ListWorkflowsParams,
} from "./endpoints";

export const POLL = {
  detail: 3_000,
  list: 8_000,
  infra: 10_000,
  metrics: 15_000,
  placements: 20_000,
} as const;

const TERMINAL = new Set(["COMPLETED", "FAILED", "ABORTED"]);

/* ------------------------------- queries ------------------------------- */

export function useWorkflow(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ["workflow", id],
    queryFn: ({ signal }) => api.getWorkflow(id!, signal),
    enabled: !!id,
    refetchInterval: (q) => {
      const wf = q.state.data as Workflow | undefined;
      return wf && TERMINAL.has(wf.state) ? false : POLL.detail;
    },
  });
}

export function useWorkflows(params: ListWorkflowsParams) {
  const api = useApi();
  return useQuery<Page<WorkflowSummary>>({
    queryKey: ["workflows", params],
    queryFn: ({ signal }) => api.listWorkflows(params, signal),
    refetchInterval: POLL.list,
    placeholderData: (prev) => prev, // cursor paging without white flashes
  });
}

/* Placements are the cockpit's only time-axis source: GET /workflows has no
   date filter and no stream, so a trend must page backwards through cursors.
   The walk is bounded, and `covered` records whether it actually reached the
   start of the window — a partial window is labelled, never drawn as zero. */
export const PLACEMENT_PAGE_SIZE = 50;
export const PLACEMENT_MAX_PAGES = 6;

export interface PlacementWindow {
  rows: WorkflowSummary[];
  /** false → the page cap stopped the walk above the window's start */
  covered: boolean;
}

async function walkPlacements(
  api: Endpoints,
  windowMs: number,
  signal?: AbortSignal,
): Promise<PlacementWindow> {
  const cutoff = Date.now() - windowMs;
  const rows: WorkflowSummary[] = [];
  let cursor: string | undefined;
  let covered = false;
  for (let page = 0; page < PLACEMENT_MAX_PAGES; page++) {
    const p = await api.listWorkflows(
      { limit: PLACEMENT_PAGE_SIZE, cursor },
      signal,
    );
    rows.push(...p.items);
    cursor = p.next_cursor ?? undefined;
    if (!cursor) {
      covered = true;
      break;
    }
    const oldest = p.items.length
      ? Date.parse(p.items[p.items.length - 1].created_at)
      : Number.NaN;
    if (!Number.isFinite(oldest) || oldest <= cutoff) {
      covered = true;
      break;
    }
  }
  return { rows, covered };
}

export function usePlacements(windowMs: number) {
  const api = useApi();
  return useQuery<PlacementWindow>({
    queryKey: ["placements", windowMs],
    queryFn: ({ signal }) => walkPlacements(api, windowMs, signal),
    refetchInterval: POLL.placements,
    placeholderData: (prev) => prev,
  });
}

export function useEvents(
  id: string | undefined,
  params: { cursor?: string; limit?: number } = {},
) {
  const api = useApi();
  return useQuery<Page<AuditEvent>>({
    queryKey: ["events", id, params],
    queryFn: ({ signal }) => api.listEvents(id!, params, signal),
    enabled: !!id,
    refetchInterval: POLL.detail,
    placeholderData: (prev) => prev,
  });
}

export function useInbound(
  id: string | undefined,
  params: { cursor?: string; limit?: number } = {},
) {
  const api = useApi();
  return useQuery<Page<InboundEvent>>({
    queryKey: ["inbound", id, params],
    queryFn: ({ signal }) => api.listInbound(id!, params, signal),
    enabled: !!id,
    refetchInterval: POLL.list,
    placeholderData: (prev) => prev,
  });
}

export function useAttempts(id: string | undefined) {
  const api = useApi();
  const qc = useQueryClient();
  return useQuery<Attempt[]>({
    queryKey: ["attempts", id],
    queryFn: ({ signal }) => api.listAttempts(id!, signal),
    enabled: !!id,
    refetchInterval: () => {
      // attempts only move while the workflow is open; read the sibling cache
      const wf = qc.getQueryData<Workflow>(["workflow", id]);
      return wf && TERMINAL.has(wf.state) ? false : POLL.detail;
    },
  });
}

export function useDlq(params: ListDlqParams = {}) {
  const api = useApi();
  return useQuery<Page<DeadLetter>>({
    queryKey: ["dlq", params],
    queryFn: ({ signal }) => api.listDlq(params, signal),
    refetchInterval: POLL.list,
    placeholderData: (prev) => prev,
  });
}

export function useDefinitions() {
  const api = useApi();
  return useQuery<Definition[]>({
    queryKey: ["definitions"],
    queryFn: ({ signal }) => api.listDefinitions(undefined, signal),
    refetchInterval: POLL.list,
  });
}

export function useMetrics() {
  const api = useApi();
  return useQuery<MetricMap>({
    queryKey: ["metrics"],
    queryFn: async ({ signal }) => parsePrometheus(await api.metrics(signal)),
    refetchInterval: POLL.metrics,
  });
}

export function useReadyz() {
  const api = useApi();
  return useQuery<Readyz, Error>({
    queryKey: ["readyz"],
    queryFn: ({ signal }) => api.readyz(signal),
    refetchInterval: POLL.infra,
    retry: 0, // 503 is a valid answer; transport errors show the disconnected chip
  });
}

export function useHealthz() {
  const api = useApi();
  return useQuery({
    queryKey: ["healthz"],
    queryFn: ({ signal }) => api.healthz(signal),
    refetchInterval: POLL.infra,
    retry: 0,
  });
}

/* ------------------------------ mutations ------------------------------ */

export function useWorkflowAction(id: string, kind: "cancel" | "retry-now") {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<ActionResult, Error, { reason: string; version: number }>({
    mutationFn: (body) =>
      kind === "cancel" ? api.cancel(id, body) : api.retryNow(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflow", id] });
      qc.invalidateQueries({ queryKey: ["events", id] });
      qc.invalidateQueries({ queryKey: ["attempts", id] });
      qc.invalidateQueries({ queryKey: ["workflows"] });
      qc.invalidateQueries({ queryKey: ["dlq"] });
    },
  });
}

export function useResolveDlq() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    ResolveResult,
    Error,
    {
      id: string;
      action: "force-terminate" | "complete-compensation";
      reason: string;
      dry_run: boolean;
    }
  >({
    mutationFn: ({ id, action, reason, dry_run }) =>
      api.resolveDlq(id, { action, reason, dry_run }),
    onSuccess: (r) => {
      if (r.dry_run) return; // a preview changed nothing; no invalidation theatre
      qc.invalidateQueries({ queryKey: ["dlq"] });
      qc.invalidateQueries({ queryKey: ["workflow", r.workflow_id] });
      qc.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
}

export function useCreateWorkflow() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    Workflow,
    Error,
    {
      def_name: string;
      business_key: string;
      input?: unknown;
      deadline?: string;
      idempotencyKey: string;
    }
  >({
    mutationFn: ({ idempotencyKey, ...body }) =>
      api.createWorkflow(body, idempotencyKey),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflows"] });
      qc.invalidateQueries({ queryKey: ["metrics"] });
    },
  });
}

export function useRegisterDefinition() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    Definition,
    Error,
    { name: string; version: number; steps: unknown }
  >({
    mutationFn: (body) => api.registerDefinition(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["definitions"] }),
  });
}

/* ------------------------------ error text ----------------------------- */

export interface ErrorView {
  kind:
    | "auth"
    | "rate"
    | "conflict"
    | "connection"
    | "notfound"
    | "validation"
    | "server"
    | "unknown";
  headline: string;
  detail?: string;
  traceId?: string;
  retryAfter?: number;
  currentVersion?: number;
}

/** One place that turns any thrown value into honest screen copy. */
export function describeError(err: unknown): ErrorView {
  if (err instanceof ConnectionError)
    return {
      kind: "connection",
      headline: "Disconnected",
      detail: err.message,
    };
  if (err instanceof AuthError)
    return {
      kind: "auth",
      headline:
        err.kind === "unauthenticated"
          ? "Authentication required"
          : "Not permitted for this key",
      detail: err.problem?.detail ?? err.message,
      traceId: err.problem?.trace_id,
    };
  if (err instanceof RateLimitError)
    return {
      kind: "rate",
      headline: "Rate limited",
      detail: `Retry after ${err.retryAfter}s.`,
      retryAfter: err.retryAfter,
    };
  if (err instanceof ConflictError)
    return {
      kind: "conflict",
      headline: "The workflow moved first",
      detail: err.problem?.detail,
      currentVersion: err.currentVersion,
      traceId: err.problem?.trace_id,
    };
  if (err instanceof ApiError) {
    if (err.status === 404)
      return {
        kind: "notfound",
        headline: "Not found",
        detail: err.problem?.detail,
        traceId: err.problem?.trace_id,
      };
    if (err.status === 422 || err.problem?.code === "VALIDATION_FAILED")
      return {
        kind: "validation",
        headline: "Rejected by validation",
        detail: err.problem?.detail,
        traceId: err.problem?.trace_id,
      };
    if (err.status >= 500)
      return {
        kind: "server",
        headline: "Server error",
        detail: err.problem?.detail,
        traceId: err.problem?.trace_id,
      };
    return {
      kind: "unknown",
      headline: err.problem?.title ?? `Error ${err.status}`,
      detail: err.problem?.detail,
      traceId: err.problem?.trace_id,
    };
  }
  if (err instanceof Error)
    return {
      kind: "unknown",
      headline:
        err.name === "AbortError" ? "Cancelled" : "Something went wrong",
      detail: err.message,
    };
  return { kind: "unknown", headline: "Something went wrong" };
}
