"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Global error boundary (Next.js App Router convention — must be a Client
 * Component). Written in the site's Arabic RTL voice rather than the
 * framework default. Kept deliberately self-contained (no shared
 * components importing server-only code) since error boundaries can fire
 * from render failures anywhere in the tree below the root layout.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[nabd-albahrain] unhandled page error:", error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <p className="font-display text-6xl font-black text-coral">!</p>
      <h1 className="mt-4 font-display text-2xl font-bold text-sea-900">حدث خطأ غير متوقع</h1>
      <p className="mt-2 max-w-md text-sm leading-7 text-ink/60">
        نعتذر، حدث خطأ أثناء تحميل هذه الصفحة. حاول مرة أخرى، أو عد إلى الصفحة الرئيسية. إذا استمر
        الخطأ فهو على الأرجح مؤقت — البيانات الأصلية متاحة دائمًا على{" "}
        <a
          href="https://data.gov.bh"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline decoration-pearl decoration-2 underline-offset-4 hover:text-coral"
        >
          data.gov.bh
        </a>
        .
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-full bg-sea-900 px-6 py-3 text-sm font-bold text-sand-50 transition-transform hover:scale-105"
        >
          إعادة المحاولة
        </button>
        <Link
          href="/"
          className="rounded-full border border-line-light px-6 py-3 text-sm font-bold text-ink/80 transition-colors hover:border-coral hover:text-coral"
        >
          الصفحة الرئيسية
        </Link>
      </div>
    </div>
  );
}
