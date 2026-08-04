import Link from "next/link";
import { NumberLatin } from "@/components/number-latin";

/** Simple prev/next + page-count pager. `hrefForPage` builds the link for a target page. */
export function Pagination({
  page,
  totalPages,
  hrefForPage,
}: {
  page: number;
  totalPages: number;
  hrefForPage: (page: number) => string;
}) {
  if (totalPages <= 1) return null;

  const linkClass =
    "rounded-lg border border-line-light px-4 py-2 font-medium text-ink/80 transition-colors hover:border-coral hover:text-coral";
  const disabledClass = "rounded-lg border border-line-light px-4 py-2 font-medium text-ink/30";

  return (
    <nav className="mt-8 flex items-center justify-center gap-4 text-sm" aria-label="ترقيم الصفحات">
      {page > 1 ? (
        <Link href={hrefForPage(page - 1)} className={linkClass}>
          السابق
        </Link>
      ) : (
        <span className={disabledClass}>السابق</span>
      )}
      <span className="text-ink/60">
        صفحة <NumberLatin value={page} /> من <NumberLatin value={totalPages} />
      </span>
      {page < totalPages ? (
        <Link href={hrefForPage(page + 1)} className={linkClass}>
          التالي
        </Link>
      ) : (
        <span className={disabledClass}>التالي</span>
      )}
    </nav>
  );
}
