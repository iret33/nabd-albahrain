/**
 * Decision logic behind the `/admin/login` Server Action, kept free of
 * `next/*` so it can be unit-tested: throttle -> constant-time compare ->
 * mint a signed session.
 *
 * Throttling is "N failures per window per client, then locked out until the
 * window resets" (`peek` before comparing so a locked-out client cannot learn
 * whether a guess was right). Every failure also costs the caller a fixed
 * delay. `clientId` should come from `clientKey()`; with TRUST_PROXY unset
 * every visitor shares one key, so set TRUST_PROXY=1 behind Cloudflare Tunnel.
 */

import { createSession, sessionSecretFromEnv } from "@/lib/admin-session";
import { peekRateLimit, rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { safeEqual } from "@/lib/sync/auth";

export const LOGIN_FAILURE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 } as const;
export const LOGIN_FAILURE_DELAY_MS = 400;

export type LoginOutcome = { kind: "ok"; session: string } | { kind: "invalid" } | { kind: "rate" };

export async function attemptLogin(
  submitted: string,
  clientId: string,
  opts: { env?: Record<string, string | undefined>; delayMs?: number; now?: number } = {},
): Promise<LoginOutcome> {
  const env = opts.env ?? process.env;
  const key = `admin-login:${clientId}`;

  if (!peekRateLimit(key, LOGIN_FAILURE_LIMIT, opts.now).ok) return { kind: "rate" };

  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    // Fail closed, but tell the operator why every login "fails" (no secrets involved).
    console.error("[admin] ADMIN_TOKEN is not set; admin login is disabled");
  } else if (safeEqual(submitted, expected)) {
    resetRateLimit(key);
    return { kind: "ok", session: await createSession(sessionSecretFromEnv(env), { now: opts.now }) };
  }

  rateLimit(key, LOGIN_FAILURE_LIMIT, opts.now);
  await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? LOGIN_FAILURE_DELAY_MS));
  return { kind: "invalid" };
}
