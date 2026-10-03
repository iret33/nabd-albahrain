/**
 * Guards every `/admin/*` route except the login form itself. No user
 * accounts: `/admin/login`'s submit handler (`src/app/admin/login/actions.ts`)
 * checks the shared `ADMIN_TOKEN` and sets a SIGNED, expiring session cookie
 * (`src/lib/admin-session.ts`); this middleware only accepts that cookie.
 * The old raw-token cookie (`admin_token`) is not recognised, so any session
 * issued by the previous code is simply logged out.
 *
 * Runs on the Edge runtime: it may import only runtime-neutral modules, which
 * is why the session code uses Web Crypto and lives outside `lib/sync/auth.ts`
 * (that file pulls in `node:crypto`). The admin page re-checks the session
 * itself (`requireAdmin`) — middleware is one layer, not the only one.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE_NAME, sessionSecretFromEnv, verifySession } from "@/lib/admin-session";

export async function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === "/admin/login") {
    return NextResponse.next();
  }

  const session = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
  if (!(await verifySession(session, sessionSecretFromEnv()))) {
    const loginUrl = new URL("/admin/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
