import Link from "next/link";
import type { Metadata } from "next";
import { SearchForm } from "@/components/search-form";
import { NumberLatin } from "@/components/number-latin";

export const metadata: Metadata = {
  title: "الصفحة غير موجودة",
  robots: { index: false },
};

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-20 text-center sm:px-6 sm:py-24">
      {/* coral, not pearl: pearl on sand is 2:1, under the 3:1 even large text needs */}
      <p className="font-display text-6xl font-black text-coral" aria-hidden="true">
        <NumberLatin value="404" />
      </p>
      <h1 className="mt-4 font-display text-2xl font-bold text-sea-900">
        <span className="sr-only">404: </span>الصفحة غير موجودة
      </h1>
      <p className="mt-2 max-w-md text-sm leading-7 text-ink-muted">
        الصفحة التي تبحث عنها غير موجودة أو تم نقلها. جرّب العودة إلى الصفحة الرئيسية، تصفح
        الفئات، أو ابحث عن ما تريد.
      </p>
      <SearchForm className="mt-6 w-full max-w-sm" label="ابحث في مجموعات البيانات" />
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-full bg-sea-900 px-6 py-3 text-sm font-bold text-sand-50 transition-transform motion-safe:hover:scale-105"
        >
          الصفحة الرئيسية
        </Link>
        <Link
          href="/categories"
          className="inline-flex min-h-11 items-center rounded-full border border-ink/55 px-6 py-3 text-sm font-bold text-ink transition-colors hover:border-coral hover:text-coral"
        >
          تصفح الفئات
        </Link>
        <Link
          href="/updates"
          className="inline-flex min-h-11 items-center rounded-full border border-ink/55 px-6 py-3 text-sm font-bold text-ink transition-colors hover:border-coral hover:text-coral"
        >
          آخر التحديثات
        </Link>
      </div>
    </div>
  );
}
