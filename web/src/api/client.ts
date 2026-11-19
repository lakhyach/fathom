/* Centralised fetch wrapper. One place owns: base routing (same-origin —
   the Vite dev proxy forwards /v1, /healthz, /readyz, /metrics to the
   loopback control plane), bearer auth, request cancellation, problem+json
   error normalisation, and rate-limit surfacing. No secrets live here:
   the key is read from settings at call time. */
import {
  ApiError,
  AuthError,
  ConflictError,
  ConnectionError,
  RateLimitError,
  isAbort,
} from "./errors";
import { looksLikeProblem } from "./guards";
import type { Problem } from "./types";

export interface ClientConfig {
  /** current bearer key or null when the operator has not presented one.
   *  Infra probes (healthz/readyz/metrics) are unauthenticated server-side
   *  and deliberately never receive the key. */
  getKey: () => string | null;
}

export interface RequestOptions {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** skip auth header even if a key exists */
  anonymous?: boolean;
  /** statuses to treat as valid answers (e.g. readyz 503 = data, not failure) */
  okStatuses?: number[];
}

export class FathomClient {
  private cfg: ClientConfig;
  constructor(cfg: ClientConfig) {
    this.cfg = cfg;
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(path, window.location.origin);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "")
          u.searchParams.set(k, String(v));
      }
    }
    return u.pathname + u.search;
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...opts.headers,
    };
    if (!opts.anonymous) {
      const key = this.cfg.getKey();
      if (key) headers["Authorization"] = `Bearer ${key}`;
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(this.url(opts.path, opts.query), {
        method: opts.method ?? "GET",
        headers,
        body,
        signal: opts.signal,
      });
    } catch (err) {
      if (isAbort(err)) throw err; // cancellation is control flow, not failure
      throw new ConnectionError();
    }

    if (res.status === 401)
      throw new AuthError("unauthenticated", await this.tryProblem(res));
    if (res.status === 403)
      throw new AuthError("forbidden", await this.tryProblem(res));
    if (res.status === 429) {
      const ra = Number.parseInt(res.headers.get("Retry-After") ?? "5", 10);
      throw new RateLimitError(
        Number.isFinite(ra) ? ra : 5,
        await this.tryProblem(res),
      );
    }

    if (!res.ok && !opts.okStatuses?.includes(res.status)) {
      const problem = await this.tryProblem(res);
      if (problem?.code === "CONFLICT_RETRY") throw new ConflictError(problem);
      throw new ApiError(
        res.status,
        problem?.code ?? "INTERNAL",
        problem?.detail ?? `Request failed with status ${res.status}`,
        problem,
      );
    }

    const ct = res.headers.get("Content-Type") ?? "";
    if (ct.includes("application/json")) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  private async tryProblem(res: Response): Promise<Problem | undefined> {
    try {
      const j: unknown = await res.json();
      return looksLikeProblem(j) ? (j as Problem) : undefined;
    } catch {
      return undefined;
    }
  }
}
