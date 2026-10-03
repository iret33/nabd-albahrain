/**
 * Two jobs, in this order:
 *
 * 1. Strip query keys that crash Next 15's `searchParams` Promise (see
 *    `UNSAFE_QUERY_KEYS`) before ANY page code runs.
 * 2. Guard every `/admin/*` route except the login form itself. No user
 *    accounts: `/admin/login`'s submit handler (`src/app/admin/login/actions.ts`)
 *    checks the shared `ADMIN_TOKEN` and sets a SIGNED, expiring session cookie
 *    (`src/lib/admin-session.ts`); this middleware only accepts that cookie.
 *    The old raw-token cookie (`admin_token`) is not recognised, so any session
 *    issued by the previous code is simply logged out.
 *
 * Runs on the Edge runtime: it may import only runtime-neutral modules, which
 * is why the session code uses Web Crypto and lives outside `lib/sync/auth.ts`
 * (that file pulls in `node:crypto`). The admin page re-checks the session
 * itself (`requireAdmin`) — middleware is one layer, not the only one.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE_NAME, sessionSecretFromEnv, verifySession } from "@/lib/admin-session";
import { requestOrigin } from "@/lib/admin/request-origin";

/**
 * Next 15 hands pages `searchParams` as a Promise and defines every query key
 * as an own property of it; a `?constructor=` key therefore replaces the
 * Promise's `.constructor` with a string and `await searchParams` throws
 * ("The .constructor property is not an object") — HTTP 500 on /search,
 * /categories/*, /publishers/*, /dataset/*, /admin/login, and a 200 with an
 * empty body on /updates (its loading.tsx commits the status first). Fuzzing
 * every other Object.prototype / Promise name found no other key that breaks.
 * Nothing in this app emits the key, so dropping it loses nothing.
 *
 * TODO: remove once Next is upgraded to a release containing the upstream fix
 * (vercel/next.js issue #98148, closed) — check the fixed version first.
 */
const UNSAFE_QUERY_KEYS = ["constructor"] as const;

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if ((pathname === "/admin" || pathname.startsWith("/admin/")) && pathname !== "/admin/login") {
    const session = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
    if (!(await verifySession(session, sessionSecretFromEnv()))) {
      // Absolute, built from the Host the visitor used (not `req.url`, which
      // carries the server's bind address) — see request-origin.ts.
      return NextResponse.redirect(new URL("/admin/login", requestOrigin(req.headers, req.url)));
    }
  }

  // Decoded match (`?%63onstructor=1` hits the same property), so this works on
  // the parsed keys, not on the raw query string. A rewrite keeps the visible
  // URL and the method; a redirect would work too and cannot loop.
  if (UNSAFE_QUERY_KEYS.some((key) => req.nextUrl.searchParams.has(key))) {
    const clean = req.nextUrl.clone();
    for (const key of UNSAFE_QUERY_KEYS) clean.searchParams.delete(key);
    return NextResponse.rewrite(clean);
  }

  return NextResponse.next();
}

/**
 * Static literal (Next requires it). Every page request passes through: a
 * `has: [{ type: "query", key: "constructor" }]` condition would let the public
 * site skip the middleware, but Next's matcher treats an EMPTY value
 * (`?constructor=`, bare `?constructor`) as absent and so would miss two of the
 * three crashing forms. The cost is one cheap Edge call per page view; `api/`
 * and `_next/` (assets, RSC data) are excluded because route handlers read a
 * plain URLSearchParams, not the `searchParams` Promise.
 */
export const config = {
  matcher: ["/admin/:path*", "/((?!api/|_next/).*)"],
};
