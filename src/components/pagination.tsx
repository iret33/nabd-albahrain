import Link from "next/link";
import { useId } from "react";
import { NumberLatin } from "@/components/number-latin";
import { JUMP_FORM_MIN_PAGES, pageWindow } from "@/lib/pager";

const ITEM = "inline-flex h-11 min-w-11 items-center justify-center rounded-lg border px-3 text-sm font-medium transition-colors";
const LINK = `${ITEM} border-line-light bg-white text-ink/80 hover:border-coral hover:text-coral`;
const CURRENT = `${ITEM} border-sea-900 bg-sea-900 font-bold text-sand-50`;
const DISABLED = `${ITEM} border-line-light text-ink-muted opacity-60`;

/** In RTL "previous" points right and "next" points left, whatever the glyph's default. */
function Chevron({ dir }: { dir: "right" | "left" }) {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d={dir === "right" ? "M7 4l6 6-6 6" : "M13 4l-6 6 6 6"} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Windowed pager: previous, `1 … p-1 p p+1 … N`, next (see `pageWindow`).
 *
 * - Every link is a real `<a href>` built by the caller (`hrefForPage`, normally
 *   `pageHref()` from list-query, which keeps every other filter), so it works
 *   without JS and a crawler/bot sees plain links. `rel="prev"/"next"` mark
 *   the neighbours; `nofollow` is for pagers whose targets must not be crawled.
 * - The current page is `aria-current="page"` and not a link.
 * - Below `sm` the number window is replaced by "page X of N" between the two
 *   arrows (seven 44px targets do not fit in 360px).
 * - With more than JUMP_FORM_MIN_PAGES pages, `jump` adds a small GET form
 *   ("go to page") that submits the listing's other params as hidden fields, so
 *   page 1,500 of a 50,000-row table is one entry, not 1,500 clicks. An
 *   out-of-range number is clamped to the last page by the data layer.
 */
export function Pagination({
  page,
  totalPages,
  hrefForPage,
  jump,
  nofollow = false,
}: {
  page: number;
  totalPages: number;
  hrefForPage: (page: number) => string;
  jump?: { action: string; hidden?: Iterable<readonly [string, string]> };
  nofollow?: boolean;
}) {
  const jumpId = useId();
  if (totalPages <= 1) return null;

  const rel = (base: "prev" | "next") => (nofollow ? `${base} nofollow` : base);
  const slots = pageWindow(page, totalPages);

  return (
    <nav aria-label="ترقيم الصفحات" className="mt-8 flex flex-col items-center gap-4">
      <ul className="flex flex-wrap items-center justify-center gap-1.5">
        <li>
          {page > 1 ? (
            <Link href={hrefForPage(page - 1)} rel={rel("prev")} className={`${LINK} gap-1.5`}>
              <Chevron dir="right" />
              السابق
            </Link>
          ) : (
            <span aria-disabled="true" className={`${DISABLED} gap-1.5`}>
              <Chevron dir="right" />
              السابق
            </span>
          )}
        </li>

        {slots.map((slot, i) =>
          slot === "gap" ? (
            <li key={`gap-${i}`} aria-hidden="true" className="hidden px-1 text-ink-muted sm:block">
              …
            </li>
          ) : (
            <li key={slot} className="hidden sm:block">
              {slot === page ? (
                <span aria-current="page" className={CURRENT}>
                  <span className="sr-only">صفحة </span>
                  <NumberLatin value={slot} grouped={false} />
                </span>
              ) : (
                <Link
                  href={hrefForPage(slot)}
                  rel={nofollow ? "nofollow" : undefined}
                  aria-label={`صفحة ${slot}`}
                  className={LINK}
                >
                  <NumberLatin value={slot} grouped={false} />
                </Link>
              )}
            </li>
          ),
        )}

        <li className="px-3 text-sm text-ink-muted sm:hidden">
          صفحة <NumberLatin value={page} grouped={false} /> من <NumberLatin value={totalPages} grouped={false} />
        </li>

        <li>
          {page < totalPages ? (
            <Link href={hrefForPage(page + 1)} rel={rel("next")} className={`${LINK} gap-1.5`}>
              التالي
              <Chevron dir="left" />
            </Link>
          ) : (
            <span aria-disabled="true" className={`${DISABLED} gap-1.5`}>
              التالي
              <Chevron dir="left" />
            </span>
          )}
        </li>
      </ul>

      <p className="hidden text-xs text-ink-muted sm:block">
        صفحة <NumberLatin value={page} grouped={false} /> من <NumberLatin value={totalPages} grouped={false} />
      </p>

      {jump && totalPages > JUMP_FORM_MIN_PAGES && (
        <form action={jump.action} method="GET" className="flex items-center gap-2 text-sm">
          {jump.hidden &&
            Array.from(jump.hidden).map(([name, value]) => <input key={`${name}=${value}`} type="hidden" name={name} value={value} />)}
          <label htmlFor={jumpId} className="text-ink-muted">
            انتقل إلى صفحة
          </label>
          <input
            id={jumpId}
            type="number"
            name="page"
            inputMode="numeric"
            min={1}
            max={totalPages}
            defaultValue={page}
            dir="ltr"
            className="tabular-figures h-11 w-24 rounded-lg border border-ink/55 bg-white px-3 text-center text-ink"
          />
          <button
            type="submit"
            className="inline-flex h-11 items-center rounded-lg bg-sea-900 px-4 font-bold text-sand-50 transition-colors hover:bg-sea-800"
          >
            اذهب
          </button>
        </form>
      )}
    </nav>
  );
}
