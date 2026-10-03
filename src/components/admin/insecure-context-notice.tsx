"use client";

/**
 * Warns on `/admin/login` (and on the dashboard it may have just drawn), when
 * the page was opened over plain http from a non-loopback host. In production
 * the session cookie is `Secure` + `__Host-` (see `src/lib/admin-session.ts`),
 * which browsers refuse to store in an insecure context, so signing in there
 * only half-works: the dashboard draws once and then bounces back to the form.
 * It would also send the token in clear text, which is why the login variant
 * warns BEFORE the token is typed.
 *
 * `window.isSecureContext` is true for https and for localhost / 127.0.0.1 and
 * false for e.g. http://192.168.1.20:3000, exactly the set of origins where the
 * browser keeps a Secure cookie (Safari on http://localhost is the one known
 * exception — use https or `pnpm dev` there). It needs no proxy headers.
 *
 * Advisory only: the form stays a plain server-action form that works without
 * JavaScript. Renders nothing on the server and on the first client render
 * (the server snapshot says "secure"), so there is no hydration mismatch.
 */

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const isSecureContext = () => window.isSecureContext;
const assumeSecureOnServer = () => true;

const COPY = {
  login: {
    title: "اتصال غير مشفّر: لن يعمل تسجيل الدخول هنا.",
    body: "تتطلب لوحة الإدارة HTTPS، لأن المتصفح لا يحفظ جلسة الدخول الآمنة عبر HTTP، ولأن الرمز سيُرسل نصًّا مكشوفًا.",
  },
  dashboard: {
    title: "اتصال غير مشفّر: لن تُحفظ هذه الجلسة.",
    body: "المتصفح لا يحفظ جلسة الدخول الآمنة عبر HTTP، فسيُطلب منك الدخول من جديد عند أي إجراء أو عند تحديث الصفحة.",
  },
} as const;

export function InsecureContextNotice({
  required,
  context = "login",
}: {
  /** True when the session cookie is Secure (production). Dev uses a plain cookie that http can store. */
  required: boolean;
  context?: "login" | "dashboard";
}) {
  const secure = useSyncExternalStore(subscribe, isSecureContext, assumeSecureOnServer);
  if (!required || secure) return null;
  const copy = COPY[context];

  return (
    <div
      role="alert"
      data-testid="insecure-context-notice"
      className={`${context === "login" ? "mt-5" : "mb-4"} rounded-lg border border-coral/40 bg-coral/10 px-3.5 py-3 text-sm leading-6 text-coral`}
    >
      <p className="font-bold">{copy.title}</p>
      <p className="mt-1 font-medium">
        {copy.body} افتح الصفحة عبر عنوان يبدأ بـ <bdi dir="ltr">https://</bdi> أو عبر <bdi dir="ltr">localhost</bdi>.
      </p>
    </div>
  );
}
