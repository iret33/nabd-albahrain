/**
 * Pure request checks for the public refresh endpoint (POST /api/refresh):
 * body validation and the cross-origin guard. Kept free of I/O so they are
 * unit-testable; the route wires them to the database.
 */

import { z } from "zod";

/** A refresh body is tiny; anything bigger is junk. */
export const MAX_REFRESH_BODY_BYTES = 1024;

/**
 * `.strict()` on purpose: a client that sends `force` (or anything else) gets
 * a 400 rather than being silently ignored — the public endpoint can never be
 * asked to force a re-download.
 */
export const RefreshBodySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("catalog") }).strict(),
  z.object({ scope: z.literal("dataset"), id: z.string().min(1).max(300) }).strict(),
]);
export type RefreshBody = z.infer<typeof RefreshBodySchema>;

export function parseRefreshBody(text: string): { ok: true; body: RefreshBody } | { ok: false } {
  if (text.length === 0 || text.length > MAX_REFRESH_BODY_BYTES) return { ok: false };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const parsed = RefreshBodySchema.safeParse(json);
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false };
}

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Cross-origin guard. A browser always sends `Origin` on a cross-site POST;
 * a missing header (curl, server-to-server, same-origin GET-like requests)
 * is allowed. When present, its host must be the host the request was
 * addressed to, or the host of the configured public site URL.
 * `Origin: null` (sandboxed iframes, file://) and unparseable values are rejected.
 */
export function isAllowedOrigin(
  origin: string | null,
  requestHost: string | null,
  siteUrl: string | undefined,
): boolean {
  if (origin === null) return true;
  const originHost = hostOf(origin);
  if (!originHost) return false;
  if (requestHost && originHost === requestHost.trim().toLowerCase()) return true;
  const siteHost = hostOf(siteUrl);
  return siteHost !== null && originHost === siteHost;
}
