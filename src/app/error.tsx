"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";

/**
 * Global error boundary (Next.js App Router convention — must be a Client
 * Component). Written in the site's Arabic RTL voice rather than the
 * framework default. Kept deliberately self-contained (no shared
 * components importing server-only code) since error boundaries can fire
 * from render failures anywhere in the tree below the root layout.
 *
 * Focus moves to the heading when it appears: the page content was swapped out
 * under a keyboard/screen-reader user, who would otherwise be left on nothing.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    console.error("[nabd-albahrain] unhandled page error:", error);
  }, [error]);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-20 text-center sm:px-6 sm:py-24">
      <p className="font-display text-6xl font-black text-coral" aria-hidden="true">
        !
      </p>
      <h1 ref={heading} tabIndex={-1} className="mt-4 font-display text-2xl font-bold text-sea-900 focus:outline-none">
        حدث خطأ غير متوقع
      </h1>
      <p className="mt-2 max-w-md text-sm leading-7 text-ink-muted">
        نعتذر، حدث خطأ أثناء تحميل هذه الصفحة. حاول مرة أخرى، أو عد إلى الصفحة الرئيسية. إذا استمر
        الخطأ فهو على الأرجح مؤقت — البيانات الأصلية متاحة دائمًا على{" "}
        <a
          href="https://data.gov.bh"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-sea-900 underline decoration-pearl decoration-2 underline-offset-4 hover:text-coral"
        >
          data.gov.bh
        </a>
        .
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-11 items-center rounded-full bg-sea-900 px-6 py-3 text-sm font-bold text-sand-50 transition-transform motion-safe:hover:scale-105"
        >
          إعادة المحاولة
        </button>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-full border border-ink/55 px-6 py-3 text-sm font-bold text-ink transition-colors hover:border-coral hover:text-coral"
        >
          الصفحة الرئيسية
        </Link>
      </div>
    </div>
  );
}
