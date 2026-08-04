/**
 * Guards every `/admin/*` route except the login form itself (Phase 6).
 * No user accounts — a single shared `ADMIN_TOKEN` compared server-side;
 * `/admin/login`'s submit handler (`src/app/admin/login/actions.ts`) sets
 * the httpOnly cookie checked here on a match.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE_NAME } from "@/lib/sync/auth";

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === "/admin/login") {
    return NextResponse.next();
  }

  const cookieToken = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
  const expected = process.env.ADMIN_TOKEN;

  if (!expected || cookieToken !== expected) {
    const loginUrl = new URL("/admin/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
