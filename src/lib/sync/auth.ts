/**
 * Shared auth check for the sync API (Phase 6: `POST /api/sync` and
 * `GET /api/sync/status`).
 *
 * Two credentials are accepted, either is sufficient:
 *
 * 1. `Authorization: Bearer $SYNC_TOKEN` — the documented, spec-required
 *    contract for external/scripted callers (cron, `curl`, CI). This is
 *    the ONLY credential `POST /api/sync` is spec'd to accept, and stays
 *    a plain `=== ` comparison against `process.env.SYNC_TOKEN`.
 * 2. The `admin_token` httpOnly cookie set by `/admin/login` on a
 *    successful `ADMIN_TOKEN` check. This lets the browser-based admin
 *    dashboard call the exact same `/api/sync` + `/api/sync/status`
 *    endpoints its "مزامنة الكل الآن" / "إعادة المحاولة" buttons need,
 *    using the session it already has, WITHOUT ever putting the
 *    `SYNC_TOKEN` secret in client-side JS/HTML — the cookie is httpOnly
 *    and travels automatically on same-origin `fetch()` calls.
 *
 * Both env vars are required to be set for their respective check to ever
 * pass (an unset env var never matches an empty/missing header, i.e. this
 * fails closed if the server is misconfigured).
 */

import type { NextRequest } from "next/server";

export const ADMIN_COOKIE_NAME = "admin_token";

export function isSyncRequestAuthorized(req: NextRequest): boolean {
  const syncToken = process.env.SYNC_TOKEN;
  if (syncToken) {
    const authHeader = req.headers.get("authorization") ?? "";
    if (authHeader === `Bearer ${syncToken}`) return true;
  }

  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const cookieToken = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
    if (cookieToken && cookieToken === adminToken) return true;
  }

  return false;
}
