import Link from "next/link";
import { NavLink } from "@/components/nav-link";
import { RefreshButton } from "@/components/refresh-button";
import { SearchForm } from "@/components/search-form";
import { loadPublicRefreshConfig } from "@/lib/sync/config";

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
 * The visual order is the DOM order (so the Tab order matches what is drawn;
 * flex `order` and grid placement only reorder visually, which used to send
 * Tab from the search box back up to the refresh button):
 *
 *   < sm   brand · refresh      /  nav (own row)  /  search (own row)
 *   sm-lg  brand · refresh      /  nav · search
 *   lg+    brand · nav · search · refresh   (one row, sticky)
 *
 * Refresh sits next to the brand below `lg` and at the far end from `lg` up,
 * and no single DOM position gives both, so the button is rendered twice and
 * CSS shows one of them (`display: none` takes the other out of the accessibility
 * tree and the Tab order). The two share one module-level state (probe, cooldown,
 * progress), so a click on either is reflected in both.
 *
 * The header is only sticky from `lg`: stacked on a phone it is ~150px, a
 * quarter of a 360x640 viewport, on every page. The nav labels are short enough
 * to fit five links in 360px; below that the list scrolls sideways instead of
 * wrapping into more rows. The refresh button is the owner's headline feature,
 * so it stays in the first row at every width (icon only below `sm`, 44px
 * target; it draws its own status bubble under itself, so no ancestor may clip
 * overflow). When the public refresh is switched off on this server
 * (`PUBLIC_REFRESH_ENABLED=0`) neither copy is rendered, so the HTML has no
 * dead-looking buttons that disappear after the first probe (see
 * `RefreshControl`, which does the same for the buttons inside pages). Printed
 * pages drop the whole header.
 */
export function SiteHeader() {
  const refreshEnabled = loadPublicRefreshConfig().enabled;
  return (
    <header className="border-b border-line-light bg-sand-50/95 backdrop-blur supports-[backdrop-filter]:bg-sand-50/80 print:hidden lg:sticky lg:top-0 lg:z-40">
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-6 lg:flex lg:gap-x-5 lg:py-3">
        <Link
          href="/"
          className="flex min-h-11 shrink-0 items-center gap-2 rounded-md"
          aria-label="نبض البحرين — الصفحة الرئيسية"
        >
          <span className="font-display text-xl font-black text-sea-900 sm:text-2xl">نبض البحرين</span>
          <span lang="en" dir="ltr" className="hidden text-xs font-medium text-ink-muted sm:inline">
            Nabd Al-Bahrain
          </span>
        </Link>

        {refreshEnabled && (
          <div className="justify-self-end lg:hidden">
            <RefreshButton variant="header" />
          </div>
        )}

        <nav
          aria-label="التنقل الرئيسي"
          className="scrollbar-none col-span-2 overflow-x-auto sm:col-span-1 lg:w-auto lg:overflow-visible"
        >
          <ul role="list" className="flex items-center">
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
          className="col-span-2 sm:col-span-1 sm:w-56 md:w-64 lg:ms-auto lg:w-60 xl:w-72"
        />

        {refreshEnabled && (
          <div className="hidden lg:block">
            <RefreshButton variant="header" />
          </div>
        )}
      </div>
    </header>
  );
}
