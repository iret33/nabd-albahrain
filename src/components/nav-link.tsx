"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * A header/footer nav link that knows whether it is the current page.
 *
 * The only client code in the header besides the refresh button: the layout is
 * shared by every route, so the active state has to come from `usePathname()`.
 * An exact match gets `aria-current="page"`; a link whose section contains the
 * current page (`/categories` while on `/categories/health`) is highlighted and
 * marked `aria-current="true"`, so the nav shows where you are on dataset-less
 * listing pages too.
 */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const exact = pathname === href;
  const inSection = !exact && href !== "/" && pathname.startsWith(`${href}/`);
  const active = exact || inSection;

  return (
    <Link
      href={href}
      aria-current={exact ? "page" : inSection ? "true" : undefined}
      // The focus ring is drawn INSIDE the link (negative offset): the mobile nav row scrolls
      // (overflow-x-auto), and an outside ring would be clipped by it.
      className={`relative inline-flex min-h-11 items-center whitespace-nowrap px-2.5 text-sm transition-colors hover:text-coral focus-visible:-outline-offset-2 sm:px-3 ${
        active
          ? "font-bold text-sea-900 after:absolute after:inset-x-2.5 after:bottom-1.5 after:h-0.5 after:rounded-full after:bg-pearl sm:after:inset-x-3"
          : "font-medium text-ink/80"
      }`}
    >
      {children}
    </Link>
  );
}
