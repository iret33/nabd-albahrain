import Link from "next/link";
import { themeColor } from "@/lib/theme-colors";
import { altTitle, displayTitle, formatDateAr } from "@/lib/format";
import { extractFeaturedMetric, looksTemporal } from "@/lib/chart-data";
import { asVizConfig, asChartData, type DatasetCardRow } from "@/lib/queries";
import { Bidi } from "@/components/bidi";
import { NumberLatin } from "@/components/number-latin";
import { Sparkline } from "@/components/charts/sparkline";

type HeadingLevel = 2 | 3 | 4;

/** The card row, plus `removedAt` for callers that load removed datasets too (list queries never do). */
export type DatasetCardData = DatasetCardRow & { removedAt?: Date | string | null };

/**
 * The standard dataset card, reused by the home rail, every listing and the
 * "related datasets" strip.
 *
 * - Title: the portal's Arabic title when it has one (`displayTitle`), with the
 *   English title muted underneath as `lang="en" dir="ltr"`; English-only
 *   datasets show their title alone. Publisher and theme are source-language
 *   text, so they go through `<Bidi>`.
 * - Date: when the SOURCE last modified the data ("عُدّلت ..."), not when this
 *   mirror synced it (after a full sync that is the same day for every card).
 *   Datasets without a source date fall back to the sync date, labelled as such.
 * - One accessible link target: the title link is stretched over the whole card
 *   (`after:absolute after:inset-0`), so the link's accessible name is the title
 *   alone, not a paragraph of card text, while the whole card stays clickable.
 *   The focus ring is drawn on the card (`has-[a:focus-visible]`), not the
 *   sliver of the title.
 * - `headingLevel`: 2 on pages whose h1 is the page title, 3 under the home
 *   page's h2 sections, so the outline never skips a level.
 */
export function DatasetCard({
  dataset,
  headingLevel = 2,
  className = "",
}: {
  dataset: DatasetCardData;
  headingLevel?: HeadingLevel;
  className?: string;
}) {
  const vizConfig = asVizConfig(dataset.vizConfig);
  const chartData = asChartData(dataset.chartData);
  const color = themeColor(dataset.theme);
  const metric = looksTemporal(vizConfig) ? extractFeaturedMetric(vizConfig, chartData) : null;
  const Heading = `h${headingLevel}` as const;

  const title = displayTitle(dataset);
  const subtitle = altTitle(dataset);
  const removed = !!dataset.removedAt;
  const modified = dataset.sourceModified ?? null;
  const dateValue = modified ?? dataset.lastSyncedAt ?? null;

  return (
    <article
      className={`group relative flex flex-col rounded-2xl border border-line-light bg-white p-5 shadow-sm transition-all has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-sea-900 motion-safe:hover:-translate-y-[3px] hover:shadow-md ${className}`}
    >
      {(dataset.theme || dataset.syncStatus === "partial" || removed) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {dataset.theme && (
            <span
              className="inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs font-medium text-white"
              style={{ background: color }}
            >
              <Bidi text={dataset.theme} />
            </span>
          )}
          {removed && (
            <span className="inline-flex w-fit items-center rounded-full bg-coral/10 px-2.5 py-1 text-xs font-medium text-coral">
              أُزيلت من المصدر
            </span>
          )}
          {dataset.syncStatus === "partial" && (
            <span className="inline-flex w-fit items-center rounded-full bg-coral/10 px-2.5 py-1 text-xs font-medium text-coral">
              معاينة جزئية
            </span>
          )}
        </div>
      )}

      {/*
        Titles, subtitle and publisher are source-language text that gets CLAMPED. Clamped text puts its
        "…" at the end of the block's own direction, so an English title in an RTL block would show the
        ellipsis at the start of the text. `dir="auto"` gives each block the direction of its text (the
        ellipsis lands at the right end of English text, the left end of Arabic) and `text-right`
        keeps every block flush with the card's right edge, which is where this RTL layout starts.
      */}
      <Heading dir="auto" className="font-display line-clamp-2 text-right text-base font-bold leading-snug text-sea-900">
        <Link
          href={`/dataset/${encodeURIComponent(dataset.id)}`}
          className="focus-visible:outline-none after:absolute after:inset-0 after:rounded-2xl after:content-['']"
        >
          <Bidi text={title} />
        </Link>
      </Heading>
      {subtitle && (
        <p lang="en" dir="ltr" className="mt-1 line-clamp-1 text-right text-xs text-ink-muted">
          {subtitle}
        </p>
      )}
      {dataset.publisher && (
        <p dir="auto" className="mt-1 line-clamp-1 text-right text-xs text-ink-muted">
          <Bidi text={dataset.publisher} />
        </p>
      )}

      {metric && metric.points.length > 1 && (
        <div className="mt-3">
          <Sparkline points={metric.points} color={color} />
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-dashed border-line-light pt-3 text-xs text-ink-muted">
        <span>
          <NumberLatin value={dataset.recordsCount} /> سجل
        </span>
        {dateValue ? (
          <span>
            {modified ? "عُدّلت" : "آخر مزامنة"}{" "}
            <time dateTime={new Date(dateValue).toISOString()}>{formatDateAr(dateValue)}</time>
          </span>
        ) : (
          <span>لم تتم المزامنة بعد</span>
        )}
      </div>
    </article>
  );
}
