/**
 * Signed admin session (replaces the old cookie whose value WAS the raw
 * `ADMIN_TOKEN`). Everything here uses Web Crypto only — no `node:crypto` —
 * because `src/middleware.ts` imports this module and runs on the Edge
 * runtime; the same code also runs in Node (server actions, route handlers,
 * tests).
 *
 * Token format: `<expEpochSeconds>.<randomHex32>.<hexHmacSha256>`; the MAC
 * covers `<exp>.<random>`. The signing key is derived (HMAC, not used
 * directly) from `SESSION_SECRET` when set, otherwise from `ADMIN_TOKEN`, so
 * rotating the admin token invalidates every outstanding session, and a leaked
 * cookie is a time-boxed capability that cannot be replayed as the password.
 *
 * There is no server-side session store (single container, no new tables):
 * logout deletes the browser's copy and a stolen cookie stays valid until it
 * expires (12h) or the secret is rotated.
 */

/** 12 hours — an admin sitting at the dashboard all day re-logs in at most once. */
export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/**
 * `__Host-` pins the cookie to this exact host (no Domain, Path=/, Secure), so
 * a sibling subdomain (the app shares hekkapp.com with other services) cannot
 * overwrite or shadow it. The prefix REQUIRES Secure, which browsers refuse to
 * store over plain http — hence the unprefixed name for `next dev` on
 * http://localhost. NODE_ENV is inlined at build time in both runtimes.
 */
export const ADMIN_COOKIE_NAME = process.env.NODE_ENV === "production" ? "__Host-nabd_admin" : "nabd_admin";

/** Attributes for `cookies().set()`. `secure` follows NODE_ENV for the same reason as the name. */
export function adminCookieOptions(maxAgeSeconds: number = ADMIN_SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Secret the session MAC is derived from: `SESSION_SECRET` if set, else `ADMIN_TOKEN`. */
export function sessionSecretFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.SESSION_SECRET || env.ADMIN_TOKEN || undefined;
}

const KEY_LABEL = "nabd-albahrain/admin-session/v1";
const TOKEN_RE = /^(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;
const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** HMAC(secret, label) used as the actual signing key, keeping the raw secret out of the token MAC. */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const derived = await crypto.subtle.sign("HMAC", root, encoder.encode(KEY_LABEL));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Mint a session token valid for `maxAgeSeconds` from `now`. Throws when no secret is configured. */
export async function createSession(
  secret: string | undefined,
  opts: { maxAgeSeconds?: number; now?: number } = {},
): Promise<string> {
  if (!secret) throw new Error("Cannot create an admin session: neither SESSION_SECRET nor ADMIN_TOKEN is set");
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const exp = nowSeconds + (opts.maxAgeSeconds ?? ADMIN_SESSION_MAX_AGE_SECONDS);
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${exp}.${nonce}`;
  const mac = await crypto.subtle.sign("HMAC", await deriveKey(secret), encoder.encode(payload));
  return `${payload}.${toHex(new Uint8Array(mac))}`;
}

/**
 * True only for an unexpired token whose MAC matches. The MAC check uses
 * `crypto.subtle.verify` (constant time). Anything malformed, forged,
 * expired or issued with a different secret is simply `false` — never throws.
 */
export async function verifySession(
  token: string | undefined | null,
  secret: string | undefined,
  opts: { now?: number } = {},
): Promise<boolean> {
  if (!token || !secret) return false;
  const match = TOKEN_RE.exec(token);
  if (!match) return false;
  const [, expRaw, nonce, macHex] = match;
  const exp = Number(expRaw);
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(exp) || exp <= nowSeconds) return false;
  // A token claiming to outlive the policy can only come from a different
  // (longer) policy or a forger; shrink-wrap it to the current maximum.
  if (exp - nowSeconds > ADMIN_SESSION_MAX_AGE_SECONDS + 60) return false;
  try {
    return await crypto.subtle.verify("HMAC", await deriveKey(secret), fromHex(macHex), encoder.encode(`${expRaw}.${nonce}`));
  } catch {
    // Web Crypto only throws on a malformed key/algorithm, never on a bad MAC.
    // Fail closed rather than 500 the middleware.
    return false;
  }
}

/** Reads one cookie out of a raw `Cookie` header (works for `Request` and `NextRequest` alike). */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
