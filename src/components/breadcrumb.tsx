import Link from "next/link";
import { Bidi } from "@/components/bidi";

export interface Crumb {
  label: string;
  /** Omit on the last crumb (the current page): it renders as plain text with aria-current. */
  href?: string;
}

/**
 * Breadcrumb trail. Two ways to call it:
 *  - `items`: the full trail (listing pages: "الرئيسية / الفئات / الصحة");
 *  - `theme`: the legacy shape the dataset page uses ("الرئيسية / <theme>").
 * Labels may be source-language text (a theme or publisher name), hence `<Bidi>`.
 */
export function Breadcrumb({ theme, items }: { theme?: string | null; items?: Crumb[] }) {
  const trail: Crumb[] =
    items ??
    [
      { label: "الرئيسية", href: "/" },
      ...(theme ? [{ label: theme, href: `/categories/${encodeURIComponent(theme)}` }] : []),
    ];

  return (
    <nav aria-label="مسار التنقل" className="text-sm text-ink-muted">
      <ol role="list" className="flex flex-wrap items-center gap-x-2">
        {trail.map((crumb, i) => (
          <li key={`${i}-${crumb.label}`} className="flex items-center gap-x-2">
            {i > 0 && <span aria-hidden="true">/</span>}
            {crumb.href ? (
              <Link href={crumb.href} className="inline-flex min-h-11 items-center rounded transition-colors hover:text-coral">
                <Bidi text={crumb.label} />
              </Link>
            ) : (
              <span aria-current="page" className="font-medium text-ink">
                <Bidi text={crumb.label} />
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
