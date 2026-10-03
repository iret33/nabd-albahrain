/**
 * Shared auth check for the sync-triggering API (`POST /api/sync`,
 * `GET /api/sync/status`, `POST /api/revalidate`, ...).
 *
 * Two credentials are accepted, either is sufficient:
 *
 * 1. `Authorization: Bearer $SYNC_TOKEN` — the documented contract for
 *    external/scripted callers (cron, `curl`, CI), compared timing-safely.
 * 2. The signed admin-session cookie set by `/admin/login` (see
 *    `src/lib/admin-session.ts`). It lets the browser dashboard call the same
 *    endpoints WITHOUT ever holding `SYNC_TOKEN`: the cookie is httpOnly and
 *    travels automatically on same-origin `fetch()`. Because a browser attaches
 *    cookies to requests the user did not intend, a cookie-authenticated
 *    state-changing request must also prove it is same-origin
 *    (`Sec-Fetch-Site: same-origin`, or `Origin` host === `Host`). The Bearer
 *    path needs no such check: a cross-site page cannot make the browser send
 *    an Authorization header it does not hold.
 *
 * Failed attempts are counted per client (`clientKey()`, only meaningful behind
 * a proxy with TRUST_PROXY=1) and, once a client has burned its budget, are
 * answered with 429 instead of 401 until the window resets. A valid admin
 * session is never throttled (its MAC cannot be brute-forced, and it keeps the
 * dashboard usable while someone else is hammering the endpoint), and neither
 * is a CORRECT Bearer SYNC_TOKEN (a 256-bit secret: only wrong guesses need
 * throttling). The admin LOGIN form is different on purpose: ADMIN_TOKEN is
 * typed into an internet-facing form, so there even the right token is refused
 * while locked out (see `src/lib/admin/login.ts`).
 *
 * IMPORTANT: every function that decides access is async. Callers MUST `await`
 * them — `if (!isSyncRequestAuthorized(req))` on an un-awaited Promise is always
 * false, i.e. an auth bypass that TypeScript does not flag
 * (`tests/security/auth-callers.test.ts` guards against it).
 *
 * Neither the tokens nor the submitted values are ever logged.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  ADMIN_COOKIE_NAME,
  readCookie,
  sessionSecretFromEnv,
  verifySession,
} from "@/lib/admin-session";
import { trustProxyEnabled } from "@/lib/env";
import { clientKey, peekRateLimit, rateLimit } from "@/lib/rate-limit";

// Re-exported for existing importers; the constant itself lives in a
// node:crypto-free module so the Edge middleware can use it.
export { ADMIN_COOKIE_NAME };

/** Failed sync-API auth attempts tolerated per client per window. */
export const SYNC_API_FAILURE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 } as const;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Constant-time string equality. Both sides are hashed first so inputs of
 * different lengths neither throw (`timingSafeEqual` requires equal lengths)
 * nor leak the expected length through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * CSRF guard for cookie-authenticated, state-changing requests. Browsers set
 * `Sec-Fetch-Site` themselves (page JS cannot forge it), so when present it is
 * authoritative; older browsers fall back to comparing `Origin` with the Host
 * the request was addressed to (`X-Forwarded-Host` only when TRUST_PROXY=1).
 * No signal at all means a non-browser client, which must use the Bearer token.
 */
export function isSameOriginRequest(
  headers: Pick<Headers, "get">,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";

  const origin = headers.get("origin");
  if (!origin || origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [headers.get("host")];
  if (trustProxyEnabled(env)) hosts.push(headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? null);
  return hosts.some((h) => !!h && h.toLowerCase() === originHost.toLowerCase());
}

export type SyncAuthResult =
  | { ok: true; via: "bearer" | "session" }
  | { ok: false; status: 401 }
  | { ok: false; status: 429; retryAfterSeconds: number };

function parseBearer(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1] : null;
}

/**
 * Decide whether a sync-API request is allowed, with the reason it was not.
 * Prefer this over `isSyncRequestAuthorized` when the route wants to answer 429
 * (use `syncAuthFailureResponse`).
 */
export async function authorizeSyncRequest(
  req: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<SyncAuthResult> {
  // 1) Admin session cookie. Unforgeable, so it bypasses the failure throttle.
  const session = readCookie(req.headers.get("cookie"), ADMIN_COOKIE_NAME);
  if (session && (await verifySession(session, sessionSecretFromEnv(env)))) {
    if (SAFE_METHODS.has(req.method.toUpperCase()) || isSameOriginRequest(req.headers, env)) {
      return { ok: true, via: "session" };
    }
  }

  // 2) Bearer token. A MATCH passes before the failure throttle is consulted:
  // SYNC_TOKEN is a 256-bit random secret in production (boot refuses anything
  // weaker), so a correct guess cannot be brute-forced and there is nothing to
  // protect by refusing it. Gating first let anonymous junk requests (ten from
  // one client, or from everyone while the client key is shared) lock out the
  // app's OWN cache-invalidation call and the owner's cron. Only wrong guesses
  // are gated and counted. The comparison is always made, even without a
  // configured token or a presented one, so timing does not reveal either.
  const syncToken = env.SYNC_TOKEN;
  const presented = parseBearer(req.headers.get("authorization"));
  const equal = safeEqual(presented ?? "", syncToken ?? "");
  if (equal && syncToken && presented) return { ok: true, via: "bearer" };

  const limiterKey = `sync-api:${clientKey(req.headers)}`;
  const gate = peekRateLimit(limiterKey, SYNC_API_FAILURE_LIMIT);
  if (!gate.ok) return { ok: false, status: 429, retryAfterSeconds: gate.retryAfterSeconds };

  rateLimit(limiterKey, SYNC_API_FAILURE_LIMIT);
  return { ok: false, status: 401 };
}

/** Boolean form of `authorizeSyncRequest` (a throttled client simply reads as unauthorized). */
export async function isSyncRequestAuthorized(req: Request): Promise<boolean> {
  return (await authorizeSyncRequest(req)).ok;
}

/** The JSON 401 / 429 (+ `Retry-After`) response for a failed `authorizeSyncRequest`. */
export function syncAuthFailureResponse(result: Extract<SyncAuthResult, { ok: false }>): Response {
  if (result.status === 429) {
    return Response.json(
      { error: "rate_limited", retryAfterSeconds: result.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds), "Cache-Control": "no-store" } },
    );
  }
  return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
