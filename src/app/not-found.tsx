import Link from "next/link";
import type { Metadata } from "next";
import { SearchForm } from "@/components/search-form";
import { NumberLatin } from "@/components/number-latin";

export const metadata: Metadata = {
  title: "الصفحة غير موجودة | نبض البحرين",
};

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <p className="font-display text-6xl font-black text-pearl">
        <NumberLatin value="404" />
      </p>
      <h1 className="mt-4 font-display text-2xl font-bold text-sea-900">الصفحة غير موجودة</h1>
      <p className="mt-2 max-w-md text-sm leading-7 text-ink/60">
        الصفحة التي تبحث عنها غير موجودة أو تم نقلها. جرّب العودة إلى الصفحة الرئيسية، تصفح
        الفئات، أو ابحث عن ما تريد.
      </p>
      <div className="mt-6 w-full max-w-sm">
        <SearchForm />
      </div>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          href="/"
          className="rounded-full bg-sea-900 px-6 py-3 text-sm font-bold text-sand-50 transition-transform hover:scale-105"
        >
          الصفحة الرئيسية
        </Link>
        <Link
          href="/categories"
          className="rounded-full border border-line-light px-6 py-3 text-sm font-bold text-ink/80 transition-colors hover:border-coral hover:text-coral"
        >
          تصفح الفئات
        </Link>
      </div>
    </div>
  );
}
