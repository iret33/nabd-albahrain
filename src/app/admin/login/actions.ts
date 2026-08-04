"use server";

/**
 * Server Actions backing `/admin/login` (Phase 6). No auth provider, no
 * user accounts — a single shared token compared server-side against
 * `process.env.ADMIN_TOKEN`, per the project's locked-minimal-deps spec.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE_NAME } from "@/lib/sync/auth";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export async function loginAction(formData: FormData): Promise<void> {
  const submitted = String(formData.get("token") ?? "");
  const expected = process.env.ADMIN_TOKEN;

  if (!expected || submitted !== expected) {
    redirect("/admin/login?error=1");
  }

  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE_NAME, expected, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });

  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_COOKIE_NAME);
  redirect("/admin/login");
}
