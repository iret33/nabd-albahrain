"use server";

/**
 * Server Actions backing `/admin/login`. No auth provider, no user accounts:
 * a single shared token checked server-side (timing-safe, throttled — see
 * `src/lib/admin/login.ts`) against `ADMIN_TOKEN`; success sets a signed,
 * 12-hour session cookie (`src/lib/admin-session.ts`), never the token itself.
 */

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE_NAME, adminCookieOptions } from "@/lib/admin-session";
import { attemptLogin } from "@/lib/admin/login";
import { clientKey } from "@/lib/rate-limit";

export async function loginAction(formData: FormData): Promise<void> {
  const submitted = String(formData.get("token") ?? "");
  const outcome = await attemptLogin(submitted, clientKey(await headers()));

  if (outcome.kind === "rate") redirect("/admin/login?error=rate");
  if (outcome.kind === "invalid") redirect("/admin/login?error=1");

  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE_NAME, outcome.session, adminCookieOptions());
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  // Expire with the SAME attributes it was set with: a `__Host-` cookie needs
  // Secure + Path=/ even on the Set-Cookie that removes it, and a bare
  // `cookieStore.delete()` omits Secure, so browsers would ignore it.
  cookieStore.set(ADMIN_COOKIE_NAME, "", adminCookieOptions(0));
  redirect("/admin/login");
}
