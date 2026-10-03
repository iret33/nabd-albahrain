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
import { isInsecureLoginRequest } from "@/lib/admin/request-origin";
import { clientKey } from "@/lib/rate-limit";

export async function loginAction(formData: FormData): Promise<void> {
  const requestHeaders = await headers();

  // In production the session cookie is `Secure` + `__Host-`, which a browser
  // refuses to store over plain http (except on loopback), so the login would
  // "succeed", draw the dashboard once from the just-set cookie and then loop
  // back to the form with nothing to explain why. Say so up front instead —
  // BEFORE the token is compared, so it neither spends the throttle budget nor
  // reveals whether the token was right. Positive evidence only: the browser's
  // own Origin header says http on a non-loopback host (X-Forwarded-Proto
  // cannot be used, Next invents it). The cookie itself is never weakened.
  if (adminCookieOptions().secure && isInsecureLoginRequest(requestHeaders)) {
    redirect("/admin/login?error=insecure");
  }

  const submitted = String(formData.get("token") ?? "");
  const outcome = await attemptLogin(submitted, clientKey(requestHeaders));

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
