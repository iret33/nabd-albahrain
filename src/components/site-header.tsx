import Link from "next/link";

/**
 * Minimal shared site header. Reused by every page via the root layout.
 * Later phases may extend this with navigation/search, but the brand
 * mark and RTL structure established here should stay stable.
 */
export function SiteHeader() {
  return (
    <header className="border-b border-line-light bg-sand-50/95 backdrop-blur supports-[backdrop-filter]:bg-sand-50/80 sticky top-0 z-40">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link
          href="/"
          className="flex items-baseline gap-2 rounded-md"
          aria-label="نبض البحرين — الصفحة الرئيسية"
        >
          <span className="font-display text-xl font-black text-sea-900 sm:text-2xl">
            نبض البحرين
          </span>
          <span className="hidden text-xs font-medium text-ink/60 sm:inline">
            Nabd Al-Bahrain
          </span>
        </Link>
        <nav aria-label="التنقل الرئيسي">
          <ul className="flex items-center gap-4 text-sm font-medium text-ink/80 sm:gap-6">
            <li>
              <Link
                href="/"
                className="rounded-md transition-colors hover:text-coral"
              >
                الرئيسية
              </Link>
            </li>
            <li>
              <Link
                href="/categories"
                className="rounded-md transition-colors hover:text-coral"
              >
                الفئات
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
