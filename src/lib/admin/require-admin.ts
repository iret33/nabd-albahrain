/**
 * Defense-in-depth for server-rendered admin pages: verify the signed session
 * again inside the page instead of trusting that `src/middleware.ts` ran (the
 * 2025 middleware-bypass CVE class made that a real failure mode). Redirects to
 * the login form when there is no valid session.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE_NAME, sessionSecretFromEnv, verifySession } from "@/lib/admin-session";

export async function requireAdmin(): Promise<void> {
  const store = await cookies();
  if (!(await verifySession(store.get(ADMIN_COOKIE_NAME)?.value, sessionSecretFromEnv()))) {
    redirect("/admin/login");
  }
}
