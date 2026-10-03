"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Error boundary for one dataset page (a failed query, a damaged row). Keeps the
 * visitor inside the site with a retry and the way back to browsing, instead of
 * the generic page error. An error boundary does not touch the HTTP status of a
 * missing dataset (that is `not-found.tsx`, and there is deliberately no
 * route-level `loading.tsx`; see the note in components/skeletons.tsx).
 */
export default function DatasetError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[nabd-albahrain] dataset page error:", error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <p aria-hidden="true" className="font-display text-6xl font-black text-coral">
        !
      </p>
      <h1 className="mt-4 font-display text-2xl font-bold text-sea-900">تعذّر عرض مجموعة البيانات</h1>
      <p className="mt-2 max-w-md text-sm leading-7 text-ink/80">
        حدث خطأ أثناء تحميل هذه المجموعة. غالبًا هو مؤقت، فحاول مرة أخرى، أو تصفّح بقية المجموعات.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="min-h-11 rounded-full bg-sea-900 px-6 py-3 text-sm font-bold text-sand-50 transition-colors hover:bg-sea-800"
        >
          إعادة المحاولة
        </button>
        <Link
          href="/categories"
          className="inline-flex min-h-11 items-center rounded-full border border-line-light px-6 py-3 text-sm font-bold text-ink/80 transition-colors hover:border-coral hover:text-coral"
        >
          تصفح الفئات
        </Link>
      </div>
    </div>
  );
}
