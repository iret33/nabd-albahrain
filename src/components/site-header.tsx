import Link from "next/link";
import { NavLink } from "@/components/nav-link";
import { RefreshButton } from "@/components/refresh-button";
import { SearchForm } from "@/components/search-form";

const NAV_ITEMS = [
  { href: "/", label: "الرئيسية" },
  { href: "/categories", label: "الفئات" },
  { href: "/publishers", label: "الجهات" },
  { href: "/updates", label: "التحديثات" },
  { href: "/about", label: "عن المشروع" },
] as const;

/**
 * Shared site header, reused by every page through the root layout.
 *
 * One flex-wrap row whose visual order changes with the viewport (the DOM order
 * is the reading/tab order: brand, nav, search, refresh):
 *
 *   < sm   brand · refresh             then nav row, then search row
 *   sm-lg  brand · search · refresh    then nav row
 *   lg+    brand · nav · search · refresh   (one row, sticky)
 *
 * The header is only sticky from `lg`: stacked on a phone it is ~150px, a
 * quarter of a 360x640 viewport, on every page. The nav labels are short enough
 * to fit five links in 360px; below that the list scrolls sideways instead of
 * wrapping into more rows. The refresh button is the owner's headline feature,
 * so it stays in the first row at every width (icon only below `sm`, 44px
 * target; it draws its own status bubble under itself, so no ancestor may clip
 * overflow).
 */
export function SiteHeader() {
  return (
    <header className="border-b border-line-light bg-sand-50/95 backdrop-blur supports-[backdrop-filter]:bg-sand-50/80 lg:sticky lg:top-0 lg:z-40">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-6 lg:flex-nowrap lg:gap-x-5 lg:py-3">
        <Link
          href="/"
          className="order-1 flex min-h-11 shrink-0 items-center gap-2 rounded-md"
          aria-label="نبض البحرين — الصفحة الرئيسية"
        >
          <span className="font-display text-xl font-black text-sea-900 sm:text-2xl">نبض البحرين</span>
          <span lang="en" dir="ltr" className="hidden text-xs font-medium text-ink-muted sm:inline">
            Nabd Al-Bahrain
          </span>
        </Link>

        <nav
          aria-label="التنقل الرئيسي"
          className="scrollbar-none order-3 w-full overflow-x-auto sm:order-4 lg:order-2 lg:w-auto lg:overflow-visible"
        >
          <ul className="flex items-center">
            {NAV_ITEMS.map((item) => (
              <li key={item.href} className="shrink-0">
                <NavLink href={item.href}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <SearchForm
          size="sm"
          label="بحث في الموقع"
          className="order-4 w-full sm:order-2 sm:ms-auto sm:w-64 lg:order-3 lg:w-60 xl:w-72"
        />

        <div className="order-2 ms-auto sm:order-3 sm:ms-0">
          <RefreshButton variant="header" />
        </div>
      </div>
    </header>
  );
}
