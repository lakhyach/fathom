/* Typed endpoint surface — every path/query/body mirrors handlers.go
   exactly (see docs/PHASE_6_SPEC_CHECKLIST.md §2). Screens import only
   from here; the client and validators stay under the hood. */
import type { FathomClient } from "./client";
import {
  vActionResult,
  vAttempt,
  vAudit,
  vDeadLetter,
  vDefinition,
  vInbound,
  vPage,
  vReadyz,
  vResolveResult,
  vWorkflow,
  vWorkflowSummary,
} from "./guards";
import type {
  ActionResult,
  Attempt,
  AuditEvent,
  DeadLetter,
  Definition,
  Healthz,
  InboundEvent,
  Page,
  Readyz,
  ResolveResult,
  Workflow,
  WorkflowSummary,
} from "./types";

export interface ListWorkflowsParams {
  state?: string;
  business_key?: string;
  cursor?: string;
  limit?: number;
}

export interface ListDlqParams {
  open?: boolean;
  class?: string;
  workflow_id?: string;
  cursor?: string;
  limit?: number;
}

export class Endpoints {
  private c: FathomClient;
  constructor(c: FathomClient) {
    this.c = c;
  }

  /* ---- infra (unauthenticated server-side; never carries the key) ---- */

  healthz(signal?: AbortSignal): Promise<Healthz> {
    return this.c.request<Healthz>({ path: "/healthz", anonymous: true, signal });
  }

  readyz(signal?: AbortSignal): Promise<Readyz> {
    // /readyz answers 503 when unready — that is data, not a transport
    // failure (relay lag is a first-class dashboard fact), so 503 is an
    // accepted status and the JSON body is validated normally.
    return this.c
      .request<unknown>({ path: "/readyz", anonymous: true, signal, okStatuses: [200, 503] })
      .then(vReadyz);
  }

  /** Prometheus exposition text (unauthenticated). */
  metrics(signal?: AbortSignal): Promise<string> {
    return this.c.request<string>({ path: "/metrics", anonymous: true, signal });
  }

  /* ---- workflows ---- */

  listWorkflows(p: ListWorkflowsParams = {}, signal?: AbortSignal): Promise<Page<WorkflowSummary>> {
    return this.c
      .request<unknown>({ path: "/v1/workflows", query: { ...p }, signal })
      .then((x) => vPage(x, "workflows page", vWorkflowSummary));
  }

  getWorkflow(id: string, signal?: AbortSignal): Promise<Workflow> {
    return this.c.request<unknown>({ path: `/v1/workflows/${id}`, signal }).then((x) => vWorkflow(x));
  }

  createWorkflow(
    body: { def_name: string; business_key: string; input?: unknown; deadline?: string },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<Workflow> {
    return this.c
      .request<unknown>({
        path: "/v1/workflows",
        method: "POST",
        body,
        headers: { "Idempotency-Key": idempotencyKey },
        signal,
      })
      .then((x) => vWorkflow(x));
  }

  listEvents(id: string, params: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<Page<AuditEvent>> {
    return this.c
      .request<unknown>({ path: `/v1/workflows/${id}/events`, query: { ...params }, signal })
      .then((x) => vPage(x, "events page", vAudit));
  }

  listInbound(id: string, params: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<Page<InboundEvent>> {
    return this.c
      .request<unknown>({ path: `/v1/workflows/${id}/inbound`, query: { ...params }, signal })
      .then((x) => vPage(x, "inbound page", vInbound));
  }

  /** attempts are served as a bare {items} envelope, unpaged (handlers.go). */
  async listAttempts(id: string, signal?: AbortSignal): Promise<Attempt[]> {
    const x = await this.c.request<unknown>({ path: `/v1/workflows/${id}/attempts`, signal });
    return vPage(x, "attempts", vAttempt).items;
  }

  cancel(id: string, body: { reason: string; version: number }, signal?: AbortSignal): Promise<ActionResult> {
    return this.c
      .request<unknown>({ path: `/v1/workflows/${id}/actions:cancel`, method: "POST", body, signal })
      .then((x) => vActionResult(x));
  }

  retryNow(id: string, body: { reason: string; version: number }, signal?: AbortSignal): Promise<ActionResult> {
    return this.c
      .request<unknown>({ path: `/v1/workflows/${id}/actions:retry-now`, method: "POST", body, signal })
      .then((x) => vActionResult(x));
  }

  /* ---- dead letters ---- */

  listDlq(p: ListDlqParams = {}, signal?: AbortSignal): Promise<Page<DeadLetter>> {
    return this.c
      .request<unknown>({ path: "/v1/dlq", query: { ...p, open: p.open === undefined ? undefined : String(p.open) }, signal })
      .then((x) => vPage(x, "dlq page", vDeadLetter));
  }

  resolveDlq(
    id: string,
    body: { action: "force-terminate" | "complete-compensation"; reason: string; dry_run?: boolean },
    signal?: AbortSignal,
  ): Promise<ResolveResult> {
    return this.c
      .request<unknown>({ path: `/v1/dlq/${id}/actions:resolve`, method: "POST", body, signal })
      .then((x) => vResolveResult(x));
  }

  /* ---- definitions ---- */

  async listDefinitions(name?: string, signal?: AbortSignal): Promise<Definition[]> {
    const x = await this.c.request<unknown>({ path: "/v1/definitions", query: { name }, signal });
    return vPage(x, "definitions", vDefinition).items;
  }

  registerDefinition(body: { name: string; version: number; steps: unknown }, signal?: AbortSignal): Promise<Definition> {
    return this.c
      .request<unknown>({ path: "/v1/definitions", method: "POST", body, signal })
      .then((x) => vDefinition(x));
  }
}
