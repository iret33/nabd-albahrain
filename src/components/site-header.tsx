import Link from "next/link";
import { SearchForm } from "@/components/search-form";

/**
 * Shared site header. Reused by every page via the root layout. Phase 5
 * extended it with /publishers + /about nav links and a compact search
 * form, keeping the original brand mark and RTL structure stable. Layout
 * wraps to a brand / search row + a separate nav row below `md` (stays
 * usable down to the 360px quality-floor width), and collapses to a
 * single row from `md` up.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line-light bg-sand-50/95 backdrop-blur supports-[backdrop-filter]:bg-sand-50/80">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 md:flex-nowrap md:px-6 md:py-4">
        <Link
          href="/"
          className="flex shrink-0 items-baseline gap-2 rounded-md"
          aria-label="نبض البحرين — الصفحة الرئيسية"
        >
          <span className="font-display text-xl font-black text-sea-900 sm:text-2xl">
            نبض البحرين
          </span>
          <span className="hidden text-xs font-medium text-ink/60 sm:inline">
            Nabd Al-Bahrain
          </span>
        </Link>

        <nav aria-label="التنقل الرئيسي" className="order-3 w-full md:order-none md:w-auto">
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium text-ink/80 md:gap-x-6">
            <li>
              <Link href="/" className="rounded-md transition-colors hover:text-coral">
                الرئيسية
              </Link>
            </li>
            <li>
              <Link href="/categories" className="rounded-md transition-colors hover:text-coral">
                الفئات
              </Link>
            </li>
            <li>
              <Link href="/publishers" className="rounded-md transition-colors hover:text-coral">
                الجهات
              </Link>
            </li>
            <li>
              <Link href="/about" className="rounded-md transition-colors hover:text-coral">
                عن المشروع
              </Link>
            </li>
          </ul>
        </nav>

        <div className="w-full sm:ms-auto sm:w-64 md:w-56 lg:w-72">
          <SearchForm size="sm" />
        </div>
      </div>
    </header>
  );
}
