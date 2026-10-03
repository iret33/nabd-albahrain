/**
 * Error types the sync engine throws on purpose, plus `describeError`, which
 * turns ANY thrown value into a short, classified, secret-free message.
 *
 * Why: Dataset.syncError and SyncLog.error are read by the admin dashboard
 * and sit one prop away from public output (and /api/sync/status echoes
 * them). Raw `Error.message` text can embed upstream URLs, SQL fragments and
 * database hosts. So the DB only ever receives `describeError(err).message`,
 * while the full error goes to the server log (`console.error`).
 */

import { ZodError } from "zod";

/**
 * A non-2xx response that survived all retries (or a fail-fast 4xx). Lives
 * here (re-exported from http.ts) so this module has no import cycle with
 * the HTTP client.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly url?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The per-attempt deadline (headers AND body) elapsed. */
export class HttpTimeoutError extends Error {
  constructor(
    message: string,
    public readonly url?: string,
  ) {
    super(message);
    this.name = "HttpTimeoutError";
  }
}

/** The run was stopped on purpose (SIGTERM/SIGINT, or the lock was lost). */
export class SyncAbortedError extends Error {
  constructor(message = "Sync aborted") {
    super(message);
    this.name = "SyncAbortedError";
  }
}

/**
 * A safety guard refused to apply data that looked wrong (empty or truncated
 * export, partial catalog, suspicious prune). Messages are authored by us,
 * contain only ids and counts, and are safe to store verbatim.
 */
export class SyncIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncIntegrityError";
  }
}

/** The catalog could not be fetched completely (count mismatch after retries). */
export class CatalogIncompleteError extends SyncIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = "CatalogIncompleteError";
  }
}

export type ErrorKind =
  | "aborted"
  | "integrity"
  | "timeout"
  | "http"
  | "network"
  | "shape"
  | "database"
  | "unknown";

export interface DescribedError {
  kind: ErrorKind;
  /** Sanitized single-line text, at most 300 characters. */
  message: string;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function causeCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function isPrismaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return (
    (typeof name === "string" && name.startsWith("PrismaClient")) ||
    typeof (err as { clientVersion?: unknown }).clientVersion === "string"
  );
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

export function describeError(err: unknown): DescribedError {
  if (err instanceof SyncAbortedError) return { kind: "aborted", message: squash(err.message) };
  if (err instanceof SyncIntegrityError) return { kind: "integrity", message: squash(err.message) };
  if (err instanceof HttpTimeoutError) {
    return { kind: "timeout", message: "Timed out waiting for the data.gov.bh portal" };
  }
  if (err instanceof HttpError) {
    return {
      kind: "http",
      message: err.status ? `HTTP ${err.status} from the data.gov.bh portal` : "Request to the data.gov.bh portal failed",
    };
  }
  if (err instanceof ZodError) {
    return { kind: "shape", message: "Unexpected response shape from the data.gov.bh portal" };
  }
  if (isPrismaError(err)) return { kind: "database", message: "Database error" };

  const code = causeCode(err);
  if (code && NETWORK_CODES.has(code)) {
    return { kind: "network", message: `Could not reach the data.gov.bh portal (${code})` };
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return { kind: "network", message: "Could not reach the data.gov.bh portal" };
  }
  if (err instanceof SyntaxError) {
    return { kind: "shape", message: "Portal response was not valid JSON" };
  }

  const name = err instanceof Error ? err.name : typeof err;
  return { kind: "unknown", message: `Unexpected error (${name})` };
}
