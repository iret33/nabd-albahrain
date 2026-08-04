import Link from "next/link";

/**
 * Shared site footer. Every page must show this exact attribution line
 * (per project spec, unchanged since Phase 4) crediting the official
 * data.gov.bh portal — this project is an independent, unofficial
 * mirror/visualization of it. Phase 5 added a small secondary nav row
 * above it for the new /publishers, /search, and /about pages.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-line-light bg-sand-100">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <nav aria-label="روابط إضافية" className="mb-4">
          <ul className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm font-medium text-ink/70 sm:justify-start">
            <li>
              <Link href="/categories" className="rounded transition-colors hover:text-coral">
                الفئات
              </Link>
            </li>
            <li>
              <Link href="/publishers" className="rounded transition-colors hover:text-coral">
                الجهات الحكومية
              </Link>
            </li>
            <li>
              <Link href="/search" className="rounded transition-colors hover:text-coral">
                البحث
              </Link>
            </li>
            <li>
              <Link href="/about" className="rounded transition-colors hover:text-coral">
                عن المشروع
              </Link>
            </li>
          </ul>
        </nav>
        <p className="text-center text-sm text-ink/70 sm:text-start">
          المصدر:{" "}
          <a
            href="https://data.gov.bh"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-sea-900 underline decoration-pearl decoration-2 underline-offset-4 transition-colors hover:text-coral"
          >
            بوابة البيانات المفتوحة لمملكة البحرين data.gov.bh
          </a>{" "}
          — مشروع مستقل غير رسمي
        </p>
      </div>
    </footer>
  );
}
