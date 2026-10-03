import Link from "next/link";
import type { Metadata } from "next";
import { THEME_PAGE_SIZE, countRecentlyUpdated, getPortalStats, getRecentlyUpdated } from "@/lib/queries";
import { getStaleAfterMs } from "@/lib/sync/config";
import { freshnessNotice } from "@/lib/freshness-notice";
import { groupByMonth } from "@/lib/months";
import { clampPage, totalPagesFor } from "@/lib/page-math";
import { listingMetadata } from "@/lib/seo";
import {
  UPDATE_WINDOWS,
  UPDATE_WINDOW_LABELS,
  parseUpdatesParams,
  updatesHref,
  windowDays,
  type UpdateWindow,
} from "@/lib/updates-window";
import { DatasetCard } from "@/components/dataset-card";
import { EmptyState } from "@/components/empty-state";
import { FreshnessLine } from "@/components/freshness-line";
import { NumberLatin } from "@/components/number-latin";
import { Pagination } from "@/components/pagination";
import { RefreshControl } from "@/components/refresh-control";

interface Props {
  searchParams: Promise<{ days?: string | string[]; page?: string | string[] }>;
}

const DESCRIPTION =
  "آخر مجموعات البيانات التي حدّثتها بوابة data.gov.bh الرسمية، من الأحدث إلى الأقدم ومجمّعة حسب الشهر — مع خلاصة Atom للمتابعة.";

/**
 * The all-time view is the canonical one; narrower windows fold into it (noindex, follow).
 *
 * `?page=` is clamped to the real last page before it reaches the title and canonical, like
 * /categories and /publishers do: `?page=99999` used to title itself "صفحة 10000" and
 * canonicalize to itself while the body showed the last page, an unbounded set of indexable
 * duplicates. The count is one `COUNT` over the SAME where-clause as the listing
 * (`countRecentlyUpdated`), not a second load of every row and card. A windowed view is noindex
 * and its canonical ignores the page, so it needs no count. If the count fails (database down)
 * the page does not break its metadata: it falls back to the plain canonical.
 */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { window, page } = parseUpdatesParams(await searchParams);
  const noindex = window !== "all";
  let shownPage = page;
  if (!noindex && page > 1) {
    try {
      shownPage = clampPage(page, totalPagesFor(await countRecentlyUpdated(null), THEME_PAGE_SIZE));
    } catch (err) {
      console.error("[updates] could not count datasets for the page clamp; using the plain canonical:", err);
      shownPage = 1;
    }
  }
  return listingMetadata({
    title: "آخر التحديثات",
    description: DESCRIPTION,
    path: "/updates",
    page: shownPage,
    noindex,
  });
}

function WindowChips({ current }: { current: UpdateWindow }) {
  const options: UpdateWindow[] = [...UPDATE_WINDOWS, "all"];
  return (
    <nav aria-label="الفترة الزمنية">
      <ul role="list" className="flex flex-wrap items-center gap-2">
        {options.map((w) => {
          const active = w === current;
          return (
            <li key={w}>
              <Link
                href={updatesHref(w)}
                aria-current={active ? "true" : undefined}
                className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors ${
                  active
                    ? "border-sea-900 bg-sea-900 text-sand-50"
                    : "border-ink/55 bg-white text-ink hover:border-coral hover:text-coral"
                }`}
              >
                {UPDATE_WINDOW_LABELS[w]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default async function UpdatesPage({ searchParams }: Props) {
  const { window, page } = parseUpdatesParams(await searchParams);
  const [result, stats] = await Promise.all([
    getRecentlyUpdated({ page, sinceDays: windowDays(window) }),
    getPortalStats(),
  ]);
  const groups = groupByMonth(result.items, (d) => d.sourceModified);
  const notice = freshnessNotice({
    latestRunStatus: stats.latestRun?.status,
    lastSuccessAt: stats.lastSuccessAt,
    now: new Date(),
    staleAfterMs: getStaleAfterMs(),
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <h1 className="font-display text-3xl font-black text-sea-900">آخر التحديثات</h1>
      <p className="mt-2 max-w-2xl text-sm leading-7 text-ink-muted">
        مجموعات البيانات مرتّبة حسب تاريخ آخر تعديل في المصدر الرسمي، الأحدث أولًا. التاريخ على كل
        بطاقة هو تاريخ نشر التحديث في data.gov.bh، لا تاريخ مزامنته هنا.
      </p>

      <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-line-light bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <FreshnessLine
          items={[
            { label: "آخر تحقق من المصدر", iso: stats.lastCheckedAt?.toISOString() ?? null },
            { label: "آخر تغيير في البيانات", iso: stats.lastDataChangeAt?.toISOString() ?? null },
          ]}
          notice={notice}
        />
        <RefreshControl variant="inline" className="print:hidden" />
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <WindowChips current={window} />
        <a
          href="/feed.xml"
          className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-coral hover:underline"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
            <circle cx="4.5" cy="15.5" r="1.8" />
            <path d="M3 8.5a8.5 8.5 0 0 1 8.5 8.5h-2.4A6.1 6.1 0 0 0 3 10.9V8.5Zm0-5A13.5 13.5 0 0 1 16.5 17h-2.4A11.1 11.1 0 0 0 3 5.9V3.5Z" />
          </svg>
          اشترك عبر خلاصة Atom
        </a>
      </div>

      <div className="mt-8">
        {result.items.length === 0 ? (
          <EmptyState
            title={window === "all" ? "لا توجد تحديثات بعد" : `لا توجد تحديثات في ${UPDATE_WINDOW_LABELS[window]}`}
            description={
              window === "all"
                ? "لم تكتمل مزامنة أي مجموعة بيانات تحمل تاريخ تعديل حتى الآن."
                : "لم تنشر البوابة تعديلات في هذه الفترة. جرّب فترة أطول."
            }
          >
            {window !== "all" && (
              <Link
                href={updatesHref("all")}
                className="inline-flex min-h-11 items-center rounded-full border border-ink/55 bg-white px-5 text-sm font-bold text-ink transition-colors hover:border-coral hover:text-coral"
              >
                عرض كل التحديثات
              </Link>
            )}
          </EmptyState>
        ) : (
          <>
            <p className="mb-6 text-sm text-ink-muted">
              <NumberLatin value={result.total} /> مجموعة بيانات
            </p>
            <div className="space-y-10">
              {groups.map((group) => (
                <section key={group.key} aria-labelledby={`month-${group.key}`}>
                  <h2
                    id={`month-${group.key}`}
                    className="mb-4 flex items-center gap-3 font-display text-xl font-bold text-sea-900"
                  >
                    <span className="h-6 w-1.5 shrink-0 rounded-full bg-pearl" aria-hidden="true" />
                    {group.label}
                  </h2>
                  <ul role="list" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {group.items.map((d) => (
                      <li key={d.id} className="flex">
                        <DatasetCard dataset={d} headingLevel={3} className="w-full" />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <Pagination
              page={result.page}
              totalPages={result.totalPages}
              hrefForPage={(p) => updatesHref(window, p)}
              jump={{ action: "/updates", hidden: window === "all" ? [] : [["days", window]] }}
            />
          </>
        )}
      </div>
    </div>
  );
}
