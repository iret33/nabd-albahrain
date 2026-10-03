import Link from "next/link";
import type { ReactNode } from "react";
import type { ListResult } from "@/lib/queries";
import { activeFilters, listHref, listSearchParams, pageHref, type OmittableListKey } from "@/lib/list-query";
import { ActiveFilterChips, FilterBar, ResultCount } from "@/components/filter-bar";
import { DatasetCard } from "@/components/dataset-card";
import { EmptyState } from "@/components/empty-state";
import { Bidi } from "@/components/bidi";
import { Pagination } from "@/components/pagination";

const GRID = "grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3";
const actionLink =
  "inline-flex min-h-11 items-center rounded-full border border-ink/55 bg-white px-5 text-sm font-bold text-ink transition-colors hover:border-coral hover:text-coral";

/**
 * Everything under the page header of a dataset listing: the filter bar, the
 * removable filter chips, the result count, the card grid, the windowed pager
 * and every empty state. /search, /categories/[theme] and /publishers/[slug]
 * all render through it, so they filter, sort, page and fail the same way.
 *
 * Every link it makes comes from list-query's href builders, so no filter is
 * ever dropped when another one changes. `omit` lists the params the page path
 * already carries (the theme on /categories/[theme]).
 *
 * `idleWhenUnfiltered` is for /search: with no query and no filter there is
 * nothing to show yet, so it prompts instead of dumping the whole catalog.
 */
export function ListingResults({
  result,
  basePath,
  omit = [],
  showQuery = false,
  queryLabel,
  idleWhenUnfiltered = false,
  countOnlyWhenFiltered = false,
  emptyTitle = "لا توجد مجموعات بيانات هنا",
  emptyDescription = "قد تكون فارغة أو لم تكتمل مزامنتها بعد.",
}: {
  result: ListResult;
  basePath: string;
  omit?: readonly OmittableListKey[];
  showQuery?: boolean;
  /** Label of the in-bar text box (only with `showQuery`). */
  queryLabel?: string;
  idleWhenUnfiltered?: boolean;
  /** The page header already states the unfiltered total (category/publisher pages): count only narrowed lists. */
  countOnlyWhenFiltered?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const { params } = result;
  const filters = activeFilters(params, omit);
  const hasFilters = filters.length > 0;
  /** Filters besides the query itself (the empty state offers to drop exactly these). */
  const hasOtherFilters = filters.some((f) => f.key !== "q");
  const idle = idleWhenUnfiltered && !hasFilters;
  const resetHref = listHref(basePath, params, { q: "", theme: null, publisher: null, since: null, hasChart: false, sort: null }, omit);

  let body: ReactNode;
  if (idle) {
    body = (
      <EmptyState
        title="ابدأ بكتابة كلمة للبحث"
        description="اكتب عنوان مجموعة بيانات، اسم جهة حكومية، أو موضوعًا في مربع البحث أعلاه — أو اختر فئة أو جهة من عوامل التصفية."
      >
        <Link href="/categories" className={actionLink}>
          تصفح الفئات
        </Link>
        <Link href="/updates" className={actionLink}>
          آخر التحديثات
        </Link>
      </EmptyState>
    );
  } else if (result.status === "query-too-short") {
    body = (
      <EmptyState
        title="كلمة البحث قصيرة جدًا"
        description="اكتب كلمة من حرفين على الأقل (أو رقمًا)، مثل «السكان» أو «health»."
      />
    );
  } else if (result.items.length === 0) {
    body = params.q ? (
      <EmptyState
        title="لا توجد نتائج لبحثك — جرّب كلمة أخرى"
        description={
          <>
            لم نعثر على مجموعات بيانات تطابق <QueryText q={params.q} />
            {hasOtherFilters ? " مع عوامل التصفية المختارة" : ""}. جرّب كلمات أقل أو مرادفًا آخر.
          </>
        }
      >
        {hasOtherFilters && (
          <Link href={listHref(basePath, params, { theme: null, publisher: null, since: null, hasChart: false }, omit)} className={actionLink}>
            إزالة عوامل التصفية
          </Link>
        )}
        <Link href="/categories" className={actionLink}>
          تصفح الفئات
        </Link>
      </EmptyState>
    ) : hasFilters ? (
      <EmptyState
        title="لا توجد مجموعات تطابق عوامل التصفية"
        description="جرّب توسيع الفترة الزمنية أو إزالة بعض العوامل."
      >
        <Link href={resetHref} className={actionLink}>
          إعادة الضبط
        </Link>
      </EmptyState>
    ) : (
      <EmptyState title={emptyTitle} description={emptyDescription} />
    );
  } else {
    body = (
      <>
        {(!countOnlyWhenFiltered || hasFilters) && (
          <div className="mb-4">
            <ResultCount total={result.total} />
          </div>
        )}
        <ul role="list" className={GRID}>
          {result.items.map((d) => (
            <li key={d.id} className="flex">
              <DatasetCard dataset={d} headingLevel={2} className="w-full" />
            </li>
          ))}
        </ul>
        <Pagination
          page={result.page}
          totalPages={result.totalPages}
          hrefForPage={(p) => pageHref(basePath, params, p, omit)}
          jump={{ action: basePath, hidden: listSearchParams(params, { page: 1 }, omit) }}
        />
      </>
    );
  }

  return (
    <>
      <FilterBar
        action={basePath}
        params={params}
        facets={result.facets}
        theme={result.theme}
        publisher={result.publisher}
        omit={omit}
        showQuery={showQuery}
        queryLabel={queryLabel}
      />
      {hasFilters && (
        <div className="mt-4">
          <ActiveFilterChips
            basePath={basePath}
            params={params}
            omit={omit}
            themeName={result.theme?.theme}
            publisherName={result.publisher?.name}
          />
        </div>
      )}
      <div className="mt-6">{body}</div>
    </>
  );
}

/**
 * The query in guillemets as ONE bidi isolate. The quotes sit inside it so they take
 * the query's own direction: outside, a Latin query in an RTL line printed "»live births«"
 * (mirrored quotes) and could be split from them across a line break.
 */
export function QueryText({ q }: { q: string }) {
  return <Bidi text={`«${q}»`} />;
}
