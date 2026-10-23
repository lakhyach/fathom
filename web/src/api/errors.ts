/* Structured API errors. Every failure a screen can show is one of these
   classes — components switch on the class, never on message strings. */
import type { Problem } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem?: Problem;
  constructor(status: number, code: string, message: string, problem?: Problem) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.problem = problem;
  }
}

/** 401/403 — the presented key is missing/unknown/under-privileged. */
export class AuthError extends ApiError {
  readonly kind: "unauthenticated" | "forbidden";
  constructor(kind: "unauthenticated" | "forbidden", problem?: Problem) {
    super(
      kind === "unauthenticated" ? 401 : 403,
      kind === "unauthenticated" ? "UNAUTHENTICATED" : "FORBIDDEN",
      kind === "unauthenticated"
        ? "No valid API key — open Settings and present a key."
        : "This key's role does not allow that action.",
      problem,
    );
    this.name = "AuthError";
    this.kind = kind;
  }
}

/** 429 — per-key budget exhausted; honour Retry-After (seconds). */
export class RateLimitError extends ApiError {
  readonly retryAfter: number;
  constructor(retryAfter: number, problem?: Problem) {
    super(429, "RATE_LIMITED", "Rate limited by the API; backing off.", problem);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

/** 409 CONFLICT_RETRY — optimistic-concurrency loss; carries current version. */
export class ConflictError extends ApiError {
  readonly currentVersion?: number;
  constructor(problem?: Problem) {
    super(409, problem?.code ?? "CONFLICT", problem?.detail ?? "The workflow advanced; retry against the current version.", problem);
    this.name = "ConflictError";
    this.currentVersion = problem?.version;
  }
}

/** Transport failure: proxy down, backend asleep, request aborted upstream. */
export class ConnectionError extends Error {
  readonly aborted: boolean;
  constructor(message = "Cannot reach the Fathom API (is the control plane running?)") {
    super(message);
    this.name = "ConnectionError";
    this.aborted = false;
  }
}

/** Response arrived but did not match the wire contract (guards failed). */
export class MalformedResponseError extends Error {
  constructor(what: string) {
    super(`Unexpected response shape for ${what}`);
    this.name = "MalformedResponseError";
  }
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export function isConnectionError(err: unknown): boolean {
  return err instanceof ConnectionError;
}
