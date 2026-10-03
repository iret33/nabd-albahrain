import Link from "next/link";

/**
 * Shown (with a real 404 status) when `/dataset/<id>` names no dataset: a
 * mistyped or outdated link, or an id the portal never had. Says what probably
 * happened and offers the two ways forward, instead of the generic 404.
 */
export default function DatasetNotFound() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <h1 className="font-display text-2xl font-bold text-sea-900">مجموعة البيانات غير موجودة</h1>
      <p className="mt-2 max-w-md text-sm leading-7 text-ink/80">
        لا توجد مجموعة بهذا المعرّف. قد يكون الرابط قديمًا أو به خطأ مطبعي. جرّب البحث بعنوان المجموعة أو تصفّح الفئات.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          href="/search"
          className="inline-flex min-h-11 items-center rounded-full bg-sea-900 px-6 py-3 text-sm font-bold text-sand-50 transition-colors hover:bg-sea-800"
        >
          ابحث في المجموعات
        </Link>
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
