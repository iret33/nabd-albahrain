/**
 * Tell the running web server to drop its Next.js data caches after a sync.
 *
 * Why an HTTP call: `revalidateTag` only works inside a Next request/route
 * handler (it throws "static generation store missing" in the CLI, in
 * instrumentation or in a timer) and, when called after a route has already
 * responded, it is a silent no-op. A POST to our own `/api/revalidate`
 * endpoint makes the call happen synchronously inside a real handler, so it
 * works for every trigger: CLI, scheduler, admin, public refresh.
 *
 * Failures are logged, never thrown: a sync must not fail because the web
 * server was restarting. The cache TTL (queries.ts) is the backstop.
 */

const NOTIFY_TIMEOUT_MS = 5_000;
/** Mirrors the cap enforced by POST /api/revalidate; the "datasets" tag covers the rest. */
const MAX_NOTIFY_IDS = 1000;
let warnedMissingToken = false;

export interface NotifyResult {
  /** True when the app confirmed the invalidation. */
  ok: boolean;
  /** Why nothing was sent / why it failed (for logs and tests). */
  reason?: "no_token" | "http" | "network";
  status?: number;
}

export function resolveAppBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.APP_INTERNAL_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `http://127.0.0.1:${env.PORT?.trim() || 3000}`;
}

export async function notifyAppToRevalidate(
  opts: { datasetIds?: string[]; tags?: string[] } = {},
): Promise<NotifyResult> {
  const token = process.env.SYNC_TOKEN;
  if (!token) {
    if (!warnedMissingToken) {
      warnedMissingToken = true;
      console.warn(
        "[notify] SYNC_TOKEN is not set, so the web server cannot be told to drop its caches; " +
          "pages will pick up the new data when their cache TTL expires.",
      );
    }
    return { ok: false, reason: "no_token" };
  }

  const url = `${resolveAppBaseUrl()}/api/revalidate`;
  const body: { tags?: string[]; datasetIds?: string[] } = {};
  if (opts.tags && opts.tags.length > 0) body.tags = opts.tags;
  const ids = [...new Set(opts.datasetIds ?? [])].slice(0, MAX_NOTIFY_IDS);
  if (ids.length > 0) body.datasetIds = ids;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Drain the (tiny) body inside the timeout window so the socket is freed.
    await res.text().catch(() => "");
    if (!res.ok) {
      console.warn(`[notify] ${url} answered HTTP ${res.status}; caches will expire via their TTL.`);
      return { ok: false, reason: "http", status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const why = err instanceof Error ? (controller.signal.aborted ? "timed out" : err.message) : String(err);
    console.warn(`[notify] Could not reach ${url} (${why}); caches will expire via their TTL.`);
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}
