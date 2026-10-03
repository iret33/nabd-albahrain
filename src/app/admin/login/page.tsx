import type { Metadata } from "next";
import { loginAction } from "./actions";

export const metadata: Metadata = {
  title: "دخول لوحة الإدارة | نبض البحرين",
  robots: { index: false, follow: false },
};

interface Props {
  searchParams: Promise<{ error?: string }>;
}

export default async function AdminLoginPage({ searchParams }: Props) {
  const { error } = await searchParams;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <div className="rounded-2xl border border-line-light bg-white p-6 shadow-sm sm:p-8">
        <h1 className="font-display text-2xl font-bold text-sea-900">لوحة الإدارة</h1>
        <p className="mt-2 text-sm leading-6 text-ink/60">
          هذه الصفحة مخصصة لإدارة مشروع نبض البحرين. أدخل رمز الدخول للمتابعة.
        </p>

        <form action={loginAction} className="mt-6 space-y-4">
          <div>
            <label htmlFor="token" className="mb-1.5 block text-sm font-medium text-ink/80">
              رمز الدخول
            </label>
            <input
              id="token"
              name="token"
              type="password"
              required
              autoComplete="off"
              autoFocus
              className="w-full rounded-lg border border-line-light bg-white px-3.5 py-2.5 text-ink outline-none focus-visible:border-pearl"
            />
          </div>

          {error && (
            <p role="alert" className="rounded-lg bg-coral/10 px-3.5 py-2.5 text-sm font-medium text-coral">
              {error === "rate"
                ? "محاولات خاطئة كثيرة. انتظر نحو 15 دقيقة ثم حاول مرة أخرى."
                : "الرمز غير صحيح. حاول مرة أخرى."}
            </p>
          )}

          <button
            type="submit"
            className="w-full rounded-lg bg-sea-900 px-4 py-2.5 font-display font-bold text-white transition-colors hover:bg-sea-800"
          >
            دخول
          </button>
        </form>
      </div>
    </div>
  );
}
