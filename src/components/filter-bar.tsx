import Link from "next/link";
import { useId, type ReactNode } from "react";
import type { ThemeCount, PublisherCount, PublisherFacet } from "@/lib/queries";
import {
  MAX_QUERY_LENGTH,
  activeFilters,
  listHref,
  removeFilterHref,
  type ListParams,
  type ListSince,
  type OmittableListKey,
} from "@/lib/list-query";
import { isolate } from "@/lib/text";
import { Bidi } from "@/components/bidi";
import { NumberLatin } from "@/components/number-latin";

export const SINCE_LABELS: Record<ListSince, string> = {
  "30d": "آخر 30 يومًا",
  "1y": "آخر سنة",
};

const FIELD =
  "h-11 w-full rounded-xl border border-ink/55 bg-white px-3 text-sm text-ink";

function Field({ label, htmlFor, className = "", children }: { label: string; htmlFor: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-ink-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * Zero-JS filter + sort form for /search and the category/publisher listings.
 *
 * A plain GET form: the browser serializes the controls into the query string,
 * the server page parses it with `parseListParams`, so every state is a
 * shareable URL and nothing needs hydrating.
 *
 *  - Option labels carry facet counts ("الصحة (12)"), computed by the data layer
 *    over the datasets matching every OTHER filter, so a count is exactly what
 *    choosing it would show. The currently selected theme/publisher is always
 *    listed, even when the other filters leave it with no rows.
 *  - "relevance" is offered only when there is a query to rank by.
 *  - `omit` hides the controls whose value the page path already fixes
 *    (the theme on /categories/[theme]); `showQuery` adds a text box for pages
 *    that have no search box of their own.
 */
export function FilterBar({
  action,
  params,
  facets,
  theme,
  publisher,
  omit = [],
  showQuery = false,
  queryLabel = "ابحث ضمن النتائج",
}: {
  action: string;
  params: ListParams;
  facets: { themes: ThemeCount[]; publishers: PublisherFacet[] };
  theme: ThemeCount | null;
  publisher: PublisherCount | null;
  omit?: readonly OmittableListKey[];
  showQuery?: boolean;
  queryLabel?: string;
}) {
  const uid = useId();
  const hide = new Set<string>(omit);

  const themes = [...facets.themes];
  if (theme && !themes.some((t) => t.theme === theme.theme)) themes.push({ theme: theme.theme, count: 0 });
  const publishers = [...facets.publishers];
  if (publisher && !publishers.some((p) => p.slug === publisher.slug)) {
    publishers.push({ slug: publisher.slug, name: publisher.name, count: 0 });
  }

  const hasTokens = params.tokens.length > 0;
  const showTheme = !hide.has("theme") && themes.length > 0;
  const showPublisher = !hide.has("publisher") && publishers.length > 0;
  const hasAny = activeFilters(params, omit).length > 0 || params.sort !== (hasTokens ? "relevance" : "title");

  return (
    <form action={action} method="GET" aria-label="تصفية النتائج وترتيبها" className="rounded-2xl border border-line-light bg-white p-4 shadow-sm">
      {!showQuery && !hide.has("q") && params.q && <input type="hidden" name="q" value={params.q} />}

      {showQuery && (
        <Field label={queryLabel} htmlFor={`${uid}-q`} className="mb-3">
          <input
            id={`${uid}-q`}
            type="search"
            name="q"
            defaultValue={params.q}
            maxLength={MAX_QUERY_LENGTH}
            autoComplete="off"
            enterKeyHint="search"
            className={FIELD}
          />
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="الترتيب" htmlFor={`${uid}-sort`}>
          <select id={`${uid}-sort`} name="sort" defaultValue={params.sort} className={FIELD}>
            {hasTokens && <option value="relevance">الأقرب صلةً</option>}
            <option value="updated">الأحدث تحديثًا</option>
            <option value="title">الاسم (أ – ي)</option>
            <option value="records">الأكثر سجلات</option>
          </select>
        </Field>

        <Field label="آخر تحديث للمصدر" htmlFor={`${uid}-since`}>
          <select id={`${uid}-since`} name="since" defaultValue={params.since ?? ""} className={FIELD}>
            <option value="">في أي وقت</option>
            <option value="30d">{SINCE_LABELS["30d"]}</option>
            <option value="1y">{SINCE_LABELS["1y"]}</option>
          </select>
        </Field>

        {showTheme && (
          <Field label="الفئة" htmlFor={`${uid}-theme`} className="col-span-2 md:col-span-1">
            <select id={`${uid}-theme`} name="theme" defaultValue={params.theme ?? ""} className={FIELD}>
              <option value="">كل الفئات</option>
              {themes.map((t) => (
                <option key={t.theme} value={t.theme}>
                  {isolate(t.theme)} ({t.count})
                </option>
              ))}
            </select>
          </Field>
        )}

        {showPublisher && (
          <Field label="الجهة" htmlFor={`${uid}-publisher`} className="col-span-2 md:col-span-1">
            <select id={`${uid}-publisher`} name="publisher" defaultValue={params.publisher ?? ""} className={FIELD}>
              <option value="">كل الجهات</option>
              {publishers.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {isolate(p.name)} ({p.count})
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="chart" value="1" defaultChecked={params.hasChart} className="h-5 w-5 accent-sea-900" />
          يحتوي رسمًا بيانيًا
        </label>
        <div className="flex items-center gap-2">
          {hasAny && (
            <Link
              href={listHref(action, params, { q: "", theme: null, publisher: null, since: null, hasChart: false, sort: null }, omit)}
              className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-ink-muted transition-colors hover:text-coral"
            >
              إعادة الضبط
            </Link>
          )}
          <button
            type="submit"
            className="inline-flex h-11 items-center rounded-lg bg-sea-900 px-6 text-sm font-bold text-sand-50 transition-colors hover:bg-sea-800"
          >
            تطبيق
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * The filters currently narrowing the list, each a link that removes just that
 * one ("×"), plus "clear all" when there are several. Renders nothing without filters.
 */
export function ActiveFilterChips({
  basePath,
  params,
  omit = [],
  themeName,
  publisherName,
}: {
  basePath: string;
  params: ListParams;
  omit?: readonly OmittableListKey[];
  /** Canonical display names (the URL carries a slug for publishers). */
  themeName?: string | null;
  publisherName?: string | null;
}) {
  const filters = activeFilters(params, omit);
  if (filters.length === 0) return null;

  const describe = (f: (typeof filters)[number]): ReactNode => {
    switch (f.key) {
      case "q":
        return (
          <>
            بحث: <Bidi text={`«${f.value}»`} />
          </>
        );
      case "theme":
        return (
          <>
            الفئة: <Bidi text={themeName ?? f.value} />
          </>
        );
      case "publisher":
        return (
          <>
            الجهة: <Bidi text={publisherName ?? f.value} />
          </>
        );
      case "chart":
        return "يحتوي رسمًا بيانيًا";
      case "since":
        return `المصدر: ${SINCE_LABELS[f.value as ListSince] ?? f.value}`;
    }
  };

  const plain = (f: (typeof filters)[number]) =>
    f.key === "q"
      ? `البحث ${f.value}`
      : f.key === "theme"
        ? `الفئة ${themeName ?? f.value}`
        : f.key === "publisher"
          ? `الجهة ${publisherName ?? f.value}`
          : f.key === "chart"
            ? "يحتوي رسمًا بيانيًا"
            : SINCE_LABELS[f.value as ListSince] ?? f.value;

  return (
    <ul role="list" aria-label="عوامل التصفية المطبّقة" className="flex flex-wrap items-center gap-2">
      {filters.map((f) => (
        <li key={f.key}>
          <Link
            href={removeFilterHref(basePath, params, f.key, omit)}
            aria-label={`إزالة عامل التصفية: ${plain(f)}`}
            className="inline-flex min-h-10 items-center gap-2 rounded-full border border-ink/55 bg-white px-3.5 text-sm font-medium text-ink transition-colors hover:border-coral hover:text-coral"
          >
            <span>{describe(f)}</span>
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </Link>
        </li>
      ))}
      {filters.length > 1 && (
        <li>
          <Link
            href={listHref(basePath, params, { q: "", theme: null, publisher: null, since: null, hasChart: false }, omit)}
            className="inline-flex min-h-10 items-center rounded-full px-3 text-sm font-medium text-ink-muted transition-colors hover:text-coral"
          >
            مسح الكل
          </Link>
        </li>
      )}
    </ul>
  );
}

/** "N نتيجة" with the Arabic dual/plural forms handled by wording that needs none. */
export function ResultCount({ total, label = "نتيجة" }: { total: number; label?: string }) {
  return (
    <p className="text-sm text-ink-muted">
      <NumberLatin value={total} /> {label}
    </p>
  );
}
