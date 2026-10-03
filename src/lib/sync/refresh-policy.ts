/**
 * Pure request checks for the public refresh endpoint (POST /api/refresh):
 * body validation and the cross-origin guard. Kept free of I/O so they are
 * unit-testable; the route wires them to the database.
 */

import { z } from "zod";
import { MAX_DATASET_ID_LENGTH, isValidDatasetId } from "@/lib/cache-config";

/** A refresh body is tiny; anything bigger is junk. */
export const MAX_REFRESH_BODY_BYTES = 1024;

/** A UTF-16 surrogate with no partner: not text, and Prisma refuses to encode it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * May this string from a URL or a JSON body be used as a dataset id in a query?
 * `isValidDatasetId` (length, no control characters, so no NUL byte, which
 * Postgres rejects) PLUS well-formedness: a JSON body can carry a lone
 * surrogate (`"a\ud800b"`), which passes the control-character test but makes
 * Prisma throw. Either way an unknown or hostile id must read as "no such
 * dataset", never as a 500 with a stack trace in the log.
 */
export function isPublicDatasetId(id: unknown): id is string {
  return isValidDatasetId(id) && !LONE_SURROGATE.test(id);
}

/**
 * `.strict()` on purpose: a client that sends `force` (or anything else) gets
 * a 400 rather than being silently ignored — the public endpoint can never be
 * asked to force a re-download. The refine sits on the `id` FIELD (a refine on
 * the object would make a ZodEffects, which a discriminated union rejects), so
 * a malformed id is a 400 before the per-client limit is touched.
 */
export const RefreshBodySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("catalog") }).strict(),
  z
    .object({
      scope: z.literal("dataset"),
      id: z.string().min(1).max(MAX_DATASET_ID_LENGTH).refine(isPublicDatasetId),
    })
    .strict(),
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
