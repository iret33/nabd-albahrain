import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getDatasetById,
  getDatasetRecordsPage,
  asVizConfig,
  asChartData,
  asFields,
  asStatsJson,
} from "@/lib/queries";
import type { StatsJson } from "@/lib/sync/derived";
import type { CatalogField } from "@/lib/sync/schemas";
import { themeColor } from "@/lib/theme-colors";
import { altTitle, displayTitle, formatDateTimeAr, stripHtml } from "@/lib/format";
import { slugify } from "@/lib/slugify";
import { SITE_URL } from "@/lib/site";
import { buildBreadcrumbJsonLd, buildDatasetJsonLd, jsonLdScript, truncateOnWord } from "@/lib/jsonld";
import {
  isRefinedRecordsView,
  isStale,
  langOf,
  officialLinks,
  parseRecordsParams,
  type RecordsParams,
} from "@/lib/dataset-page";
import { NOUNS } from "@/lib/arabic-count";
import { Breadcrumb } from "@/components/breadcrumb";
import { CountNoun } from "@/components/count-noun";
import { NumberLatin } from "@/components/number-latin";
import { MixedBidiText } from "@/components/bidi";
import { FreshnessLine } from "@/components/freshness-line";
import { RefreshControl } from "@/components/refresh-control";
import { StatChip } from "@/components/stat-chip";
import { RemovedBanner } from "@/components/removed-banner";
import { DatasetDescription } from "@/components/dataset-description";
import { CopyLinkButton } from "@/components/copy-link-button";
import { FieldDictionary } from "@/components/field-dictionary";
import { RelatedDatasets } from "@/components/related-datasets";
import { ChartFigure } from "@/components/charts/chart-figure";
import { RecordsTable } from "@/components/records-table";
import { EmptyState } from "@/components/empty-state";

type SearchParams = Record<string, string | string[] | undefined>;

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}

/** `<title>` / og:title budget: long portal titles (some run 300 characters) are cut on a word boundary. */
const META_TITLE_MAX = 120;
const META_DESCRIPTION_MAX = 160;

function decodeIdParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The canonical URL is always the bare `/dataset/<id>`. Views that only
 * re-sort, re-page or search the records table are `noindex,follow`: each is a
 * distinct cold query and together they are an endless crawl space. A dataset
 * the portal has removed is not indexed either. Titles carry no site suffix
 * (the root layout's title template adds it).
 */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const id = decodeIdParam((await params).id);
  const dataset = await getDatasetById(id);
  if (!dataset) return { title: "مجموعة بيانات غير موجودة", robots: { index: false, follow: false } };

  const refined = isRefinedRecordsView(parseRecordsParams(await searchParams));
  const name = displayTitle(dataset);
  const title = truncateOnWord(name, META_TITLE_MAX);
  const description = truncateOnWord(dataset.summaryAr || stripHtml(dataset.description) || name, META_DESCRIPTION_MAX);
  const canonical = `/dataset/${encodeURIComponent(id)}`;

  return {
    title,
    description,
    alternates: { canonical },
    robots: refined || dataset.removedAt ? { index: false, follow: true } : undefined,
    openGraph: { type: "website", siteName: "نبض البحرين", locale: "ar_AR", title, description, url: canonical },
    twitter: { card: "summary", title, description },
  };
}

const downloadLinkClass =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line-light bg-white px-4 py-2.5 text-sm font-medium text-ink/80 shadow-sm transition-colors hover:border-coral hover:text-coral";

/**
 * The records table, awaited in place (no <Suspense>). Streamed content sits in
 * a hidden template until an inline script reveals it, so in a browser without
 * JavaScript a Suspense boundary would leave the table (and its search, sort
 * links and pager, which are all plain GET links and a GET form) a permanent
 * skeleton. The `notFound()` check in DatasetPage runs before this renders, so
 * a missing dataset keeps its real 404 status either way. The queries behind it
 * are cached for page 1 and time-capped otherwise (`RECORDS_STATEMENT_TIMEOUT_MS`).
 *
 * It is its own component, and a sibling of RelatedDatasets in the page, so the
 * two queries still run concurrently rather than one after the other. A failed
 * read costs this section only, with a notice: an exception escaping here would
 * replace the whole page with the error boundary.
 */
async function RecordsSection({
  datasetId,
  title,
  total,
  view,
  fields,
  stats,
}: {
  datasetId: string;
  title: string;
  /** The dataset's stored row count (saves a COUNT when there is no search). */
  total: number;
  view: RecordsParams;
  fields: CatalogField[];
  stats: StatsJson | null;
}) {
  try {
    const recordsPage = await getDatasetRecordsPage({
      datasetId,
      page: view.page,
      sort: view.sort,
      dir: view.dir,
      rq: view.rq,
      total,
    });
    return <RecordsTable datasetId={datasetId} title={title} fields={fields} stats={stats} page={recordsPage} />;
  } catch (err) {
    console.error(`[dataset page] records unavailable for ${datasetId}:`, err);
    return (
      <p role="status" className="rounded-xl border border-coral/40 bg-coral/5 px-4 py-3 text-sm leading-7 text-ink/80">
        تعذّر تحميل السجلات الآن. حدّث الصفحة بعد قليل، أو نزّل البيانات كاملة من المصدر الرسمي أعلاه.
      </p>
    );
  }
}

function NoChartNote({ reason }: { reason: "geo" | "no-viz" | "none" }) {
  return (
    <div className="rounded-2xl border border-line-light bg-white px-6 py-10 text-center text-sm leading-7 text-ink/80 shadow-sm">
      {reason === "geo"
        ? "هذه مجموعة بيانات جغرافية (مواقع)، فلا يُرسم لها مخطط تلقائي — يمكن تصفح سجلاتها في الجدول أدناه."
        : "لا يتوفر رسم بياني مناسب لهذه المجموعة — يمكن تصفح البيانات في الجدول أدناه."}
    </div>
  );
}

function NoRecordsState({ syncStatus }: { syncStatus: string }) {
  if (syncStatus === "pending") {
    return (
      <EmptyState
        title="لم تتم مزامنة هذه المجموعة بعد"
        description="لا تتوفر بيانات مخزّنة محليًا لهذه المجموعة حتى الآن. يمكنك تحميلها مباشرة من المصدر الرسمي أدناه."
      />
    );
  }
  if (syncStatus === "error") {
    return (
      <EmptyState
        title="تعذّرت مزامنة بيانات هذه المجموعة"
        description="حدثت مشكلة أثناء تنزيل سجلات هذه المجموعة من المصدر. ستُعاد المحاولة تلقائيًا، ويمكنك تحميلها مباشرة من المصدر الرسمي أدناه."
      />
    );
  }
  return (
    <EmptyState
      title="لا تحتوي هذه المجموعة على سجلات"
      description="المصدر الرسمي لا يعرض أي سجلات لهذه المجموعة حاليًا."
    />
  );
}

export default async function DatasetPage({ params, searchParams }: Props) {
  const id = decodeIdParam((await params).id);
  const dataset = await getDatasetById(id);
  if (!dataset) notFound();

  const view = parseRecordsParams(await searchParams);

  const vizConfig = asVizConfig(dataset.vizConfig);
  const chartData = asChartData(dataset.chartData);
  const fields = asFields(dataset.fieldsJson);
  const stats = asStatsJson(dataset.statsJson);
  const color = themeColor(dataset.theme);

  const title = displayTitle(dataset);
  const subtitle = altTitle(dataset);
  const description = stripHtml(dataset.description);
  const keywords = Array.from(new Set(dataset.keywords.map((k) => k.trim()).filter((k) => k !== "")));

  const hasRecords = dataset.sourceCount > 0;
  const removed = dataset.removedAt !== null;
  const partial = dataset.syncStatus === "partial";
  const stale = !removed && isStale(dataset.lastCheckedAt, dataset.lastSyncedAt);
  const { csvUrl, jsonUrl, officialPageUrl } = officialLinks(id);

  const structuredData = jsonLdScript([
    buildDatasetJsonLd({
      siteUrl: SITE_URL,
      id,
      name: title,
      alternateName: subtitle,
      // The portal's own text first (it is what Dataset Search indexes), else our summary line.
      description: description || dataset.summaryAr,
      publisher: dataset.publisher,
      theme: dataset.theme,
      keywords,
      license: dataset.license,
      sourceModified: dataset.sourceModified,
      officialPageUrl,
      csvUrl,
      jsonUrl,
      fieldLabels: fields.flatMap((f) => (f.name ? [f.label?.trim() || f.name] : [])),
      removed,
    }),
    buildBreadcrumbJsonLd([
      { name: "الرئيسية", url: SITE_URL },
      ...(dataset.theme ? [{ name: dataset.theme, url: `${SITE_URL}/categories/${encodeURIComponent(dataset.theme)}` }] : []),
      { name: title, url: `${SITE_URL}/dataset/${encodeURIComponent(id)}` },
    ]),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} />

      <Breadcrumb
        items={[
          { label: "الرئيسية", href: "/" },
          ...(dataset.theme ? [{ label: dataset.theme, href: `/categories/${encodeURIComponent(dataset.theme)}` }] : []),
          { label: title },
        ]}
      />

      {removed && <RemovedBanner removedAt={dataset.removedAt} lastSyncedAt={dataset.lastSyncedAt} />}

      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          {dataset.theme && (
            <Link
              href={`/categories/${encodeURIComponent(dataset.theme)}`}
              className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium text-white"
              style={{ background: color }}
            >
              <bdi>{dataset.theme}</bdi>
            </Link>
          )}
          {partial && (
            <span className="inline-flex items-center rounded-full bg-coral/10 px-3 py-1 text-xs font-medium text-coral">
              معاينة جزئية — حمّل الملف الكامل من المصدر
            </span>
          )}
          {stale && (
            <span className="inline-flex items-center rounded-full bg-coral/10 px-3 py-1 text-xs font-medium text-coral">
              قد تكون البيانات قديمة
            </span>
          )}
        </div>

        <h1 className="mt-3 break-words font-display text-2xl font-black leading-tight text-sea-900 sm:text-4xl">
          <bdi lang={langOf(title)}>{title}</bdi>
        </h1>
        {subtitle && (
          <p className="mt-1.5 break-words text-base text-ink/70">
            <bdi lang="en" dir="ltr">
              {subtitle}
            </bdi>
          </p>
        )}

        {dataset.summaryAr && (
          <p className="mt-4 max-w-3xl text-lg leading-8 text-ink/80">
            <MixedBidiText text={dataset.summaryAr} />
          </p>
        )}

        <DatasetDescription text={description} className="mt-3" />

        <div className="mt-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 rounded-2xl border border-line-light bg-white px-4 py-3 shadow-sm">
          <FreshnessLine
            className="min-w-0 flex-1 basis-72 py-1"
            items={[
              { label: "آخر تعديل بالمصدر", iso: dataset.sourceModified?.toISOString() },
              { label: "آخر مزامنة", iso: dataset.lastSyncedAt?.toISOString() },
              ...(removed ? [] : [{ label: "آخر تحقق من المصدر", iso: dataset.lastCheckedAt?.toISOString() }]),
            ]}
          />
          {!removed && (
            <div className="print:hidden">
              <RefreshControl scope="dataset" datasetId={id} variant="inline" />
            </div>
          )}
        </div>

        {/* On paper only: where this page lives and how old its data is. Relative times ("منذ ساعة") mean nothing on a printout. */}
        <p className="mt-3 hidden text-xs leading-6 text-ink/80 print:block">
          نبض البحرين:{" "}
          <span dir="ltr" className="tabular-figures">
            {`${SITE_URL}/dataset/${encodeURIComponent(id)}`}
          </span>
          {dataset.sourceModified && <> — آخر تعديل بالمصدر: {formatDateTimeAr(dataset.sourceModified)}</>}
          {dataset.lastSyncedAt && <> — آخر مزامنة: {formatDateTimeAr(dataset.lastSyncedAt)}</>}
        </p>
      </header>

      <section aria-labelledby="chart-heading" className="mt-8">
        <h2 id="chart-heading" className="sr-only">
          الرسم البياني
        </h2>
        {hasRecords ? (
          vizConfig && chartData && vizConfig.type !== "table" ? (
            <ChartFigure
              datasetId={id}
              vizConfig={vizConfig}
              chartData={chartData}
              color={color}
              summaryAr={dataset.summaryAr}
            />
          ) : (
            <NoChartNote reason={vizConfig?.type === "table" ? vizConfig.reason : "none"} />
          )
        ) : (
          <NoRecordsState syncStatus={dataset.syncStatus} />
        )}
      </section>

      <section aria-labelledby="facts-heading" className="mt-6">
        <h2 id="facts-heading" className="sr-only">
          معلومات المجموعة
        </h2>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatChip
            label="السجلات"
            value={<NumberLatin value={hasRecords ? dataset.sourceCount : dataset.recordsCount} />}
            note={
              partial && dataset.sourceCount > 0 && dataset.recordsCount > dataset.sourceCount ? (
                <>
                  عُرض <CountNoun n={dataset.sourceCount} forms={NOUNS.record} /> من أصل{" "}
                  <NumberLatin value={dataset.recordsCount} />
                </>
              ) : undefined
            }
          />
          <StatChip label="الحقول" value={<NumberLatin value={fields.length} />} />
          <StatChip
            className="col-span-2 lg:col-span-1"
            label="الناشر"
            value={
              dataset.publisher ? (
                <Link href={`/publishers/${slugify(dataset.publisher)}`} className="transition-colors hover:text-coral">
                  <bdi>{dataset.publisher}</bdi>
                </Link>
              ) : (
                "غير معروف"
              )
            }
          />
          <StatChip
            className="col-span-2 lg:col-span-1"
            label="الترخيص"
            value={dataset.license ? <bdi>{dataset.license}</bdi> : "غير محدد"}
          />
        </dl>

        {keywords.length > 0 && (
          <div className="mt-5">
            <h3 className="text-xs font-medium text-ink/70">الكلمات المفتاحية</h3>
            <ul className="mt-2 flex flex-wrap gap-2">
              {keywords.map((keyword) => (
                <li key={keyword} className="max-w-full">
                  <Link
                    href={`/search?q=${encodeURIComponent(keyword)}`}
                    className="inline-flex min-h-9 max-w-full items-center rounded-full border border-line-light bg-white px-3 text-xs text-ink/80 transition-colors hover:border-coral hover:text-coral"
                  >
                    <bdi className="truncate">{keyword}</bdi>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3 print:hidden">
          {!removed && (
            <>
              <a href={csvUrl} target="_blank" rel="noopener noreferrer" className={downloadLinkClass}>
                CSV من المصدر الرسمي
              </a>
              <a href={jsonUrl} target="_blank" rel="noopener noreferrer" className={downloadLinkClass}>
                JSON من المصدر الرسمي
              </a>
              <a href={officialPageUrl} target="_blank" rel="noopener noreferrer" className={downloadLinkClass}>
                صفحة البيانات الرسمية
              </a>
            </>
          )}
          <CopyLinkButton title={title} />
        </div>
      </section>

      {fields.length > 0 && <FieldDictionary className="mt-8" fields={fields} stats={stats} />}

      {hasRecords && (
        <section aria-labelledby="records-heading" className="mt-10">
          <h2 id="records-heading" className="font-display text-xl font-bold text-sea-900">
            البيانات
          </h2>
          <div className="mt-4">
            <RecordsSection
              datasetId={id}
              title={title}
              total={dataset.sourceCount}
              view={view}
              fields={fields}
              stats={stats}
            />
          </div>
        </section>
      )}

      <RelatedDatasets id={id} theme={dataset.theme} publisher={dataset.publisher} />

      <p className="mt-12 border-t border-line-light pt-6 text-xs leading-6 text-ink/70">
        المصدر:{" "}
        {removed ? (
          "بوابة البيانات المفتوحة data.gov.bh (أُزيلت هذه المجموعة منها)"
        ) : (
          <a
            href={officialPageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-pearl decoration-2 underline-offset-4 transition-colors hover:text-coral"
          >
            صفحة هذه المجموعة على data.gov.bh
          </a>
        )}
        {!removed && (
          <span dir="ltr" className="hidden print:inline">
            {" "}
            ({officialPageUrl})
          </span>
        )}{" "}
        — مشروع نبض البحرين مستقل وغير رسمي.
      </p>
    </div>
  );
}
