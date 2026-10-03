/**
 * What `/admin/login?error=<code>` says. Kept next to (not inside) the page so a
 * test can pin that every redirect code the code base emits has its own
 * message: before this, anything other than `rate` rendered "wrong token", so a
 * new code without a branch would have blamed the visitor for our diagnostic.
 *
 * Codes: `rate` (throttled), `insecure` (plain http, the Secure cookie cannot
 * be stored — see `loginAction`), `session` (the dashboard got a 401: expired,
 * rotated secret, or the browser dropped the cookie), anything else = wrong token.
 */

export type LoginErrorCode = "rate" | "insecure" | "session";

export const LOGIN_ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  rate: "محاولات خاطئة كثيرة. انتظر نحو 15 دقيقة ثم حاول مرة أخرى.",
  insecure:
    "تعذّر تسجيل الدخول عبر اتصال غير مشفّر (HTTP): لا يحفظ المتصفح جلسة الدخول الآمنة عبر HTTP. افتح لوحة الإدارة عبر https:// أو عبر localhost ثم حاول مرة أخرى.",
  session:
    "انتهت الجلسة. سجّل الدخول من جديد. وإن تكرر ذلك مباشرة بعد الدخول فالمتصفح لا يحفظ ملف الجلسة: استخدم https:// أو localhost.",
};

export const WRONG_TOKEN_MESSAGE = "الرمز غير صحيح. حاول مرة أخرى.";

/** The message for a `?error=` value (`undefined`/empty = no error banner). */
export function loginErrorMessage(error: string | string[] | undefined): string | null {
  const code = Array.isArray(error) ? error[0] : error;
  if (!code) return null;
  return Object.hasOwn(LOGIN_ERROR_MESSAGES, code) ? LOGIN_ERROR_MESSAGES[code as LoginErrorCode] : WRONG_TOKEN_MESSAGE;
}
