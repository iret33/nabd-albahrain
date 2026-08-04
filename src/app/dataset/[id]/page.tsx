import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { CatalogField } from "@/lib/sync/schemas";
import {
  getDatasetById,
  getDatasetRecordsPage,
  asVizConfig,
  asChartData,
  asFields,
} from "@/lib/queries";
import { themeColor } from "@/lib/theme-colors";
import { formatDateAr, stripHtml } from "@/lib/format";
import { Breadcrumb } from "@/components/breadcrumb";
import { NumberLatin } from "@/components/number-latin";
import { DatasetChart } from "@/components/charts/dataset-chart";
import { RecordsTable } from "@/components/records-table";
import { EmptyState } from "@/components/empty-state";
import { RecordsTableSkeleton } from "@/components/skeletons";

const ODS_BASE = "https://data.gov.bh/api/explore/v2.1";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; sort?: string; dir?: string }>;
}

function decodeIdParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const id = decodeIdParam((await params).id);
  const dataset = await getDatasetById(id);
  if (!dataset) return { title: "مجموعة بيانات غير موجودة | نبض البحرين" };
  return {
    title: `${dataset.titleClean} | نبض البحرين`,
    description: dataset.summaryAr || stripHtml(dataset.description) || dataset.titleClean,
  };
}

function StatChip({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-line-light bg-white px-4 py-3 shadow-sm">
      <p className="text-xs text-ink/50">{label}</p>
      <p className="mt-1 font-display text-lg font-bold text-sea-900">{value}</p>
    </div>
  );
}

const downloadLinkClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-line-light bg-white px-4 py-2.5 text-sm font-medium text-ink/80 shadow-sm transition-colors hover:border-coral hover:text-coral";

/**
 * The records table lives in its own async component wrapped in
 * <Suspense> further down, rather than being awaited directly in
 * DatasetPage. It's the same data either way — this only exists so the
 * (comparatively slower, raw-SQL) sorted-records query can stream in
 * after the header/chart, without moving the `notFound()` check behind a
 * Suspense boundary (see the note on DatasetDetailSkeleton in
 * components/skeletons.tsx for why that matters).
 */
async function RecordsSection({
  datasetId,
  page,
  sortField,
  sortDir,
  fields,
}: {
  datasetId: string;
  page: number;
  sortField: string | null;
  sortDir: "asc" | "desc";
  fields: CatalogField[];
}) {
  const recordsPage = await getDatasetRecordsPage(datasetId, page, sortField, sortDir, fields);
  return <RecordsTable datasetId={datasetId} fields={fields} page={recordsPage} />;
}

export default async function DatasetPage({ params, searchParams }: Props) {
  const id = decodeIdParam((await params).id);
  const dataset = await getDatasetById(id);
  if (!dataset) notFound();

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const sortDir: "asc" | "desc" = sp.dir === "desc" ? "desc" : "asc";
  const sortField = sp.sort && sp.sort.trim() !== "" ? sp.sort : null;

  const vizConfig = asVizConfig(dataset.vizConfig);
  const chartData = asChartData(dataset.chartData);
  const fields = asFields(dataset.fieldsJson);
  const color = themeColor(dataset.theme);

  const hasRecords = dataset.sourceCount > 0;
  const description = stripHtml(dataset.description);

  const csvUrl = `${ODS_BASE}/catalog/datasets/${encodeURIComponent(id)}/exports/csv?use_labels=true`;
  const jsonUrl = `${ODS_BASE}/catalog/datasets/${encodeURIComponent(id)}/exports/json`;
  const officialPageUrl = `https://www.data.gov.bh/explore/dataset/${encodeURIComponent(id)}/`;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Breadcrumb theme={dataset.theme} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {dataset.theme && (
          <span
            className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium text-white"
            style={{ background: color }}
          >
            {dataset.theme}
          </span>
        )}
        {dataset.syncStatus === "partial" && (
          <span className="inline-flex items-center rounded-full bg-coral/10 px-3 py-1 text-xs font-medium text-coral">
            معاينة جزئية — حمّل الملف الكامل من المصدر
          </span>
        )}
      </div>

      <h1 className="mt-3 font-display text-2xl font-black leading-tight text-sea-900 sm:text-4xl">
        {dataset.titleClean}
      </h1>

      {dataset.summaryAr && (
        <p className="mt-4 max-w-3xl text-lg leading-8 text-ink/80">{dataset.summaryAr}</p>
      )}

      {hasRecords ? (
        <div className="mt-8 rounded-2xl border border-line-light bg-white p-4 shadow-sm sm:p-6">
          {vizConfig && chartData && vizConfig.type !== "table" ? (
            <DatasetChart vizConfig={vizConfig} chartData={chartData} color={color} />
          ) : (
            <p className="py-10 text-center text-sm text-ink/50">
              لا يتوفر رسم بياني مناسب لهذه المجموعة — يمكن تصفح البيانات في الجدول أدناه.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-8">
          <EmptyState
            title="لم تتم مزامنة هذه المجموعة بعد"
            description="لا تتوفر بيانات مخزّنة محليًا لهذه المجموعة حتى الآن. يمكنك تحميلها مباشرة من المصدر الرسمي أدناه."
          />
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <StatChip label="السجلات" value={<NumberLatin value={hasRecords ? dataset.sourceCount : dataset.recordsCount} />} />
        <StatChip label="الحقول" value={<NumberLatin value={fields.length} />} />
        <StatChip label="الناشر" value={dataset.publisher || "غير معروف"} />
        <StatChip label="آخر تعديل بالمصدر" value={formatDateAr(dataset.sourceModified)} />
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <a href={csvUrl} target="_blank" rel="noopener noreferrer" className={downloadLinkClass}>
          CSV من المصدر الرسمي
        </a>
        <a href={jsonUrl} target="_blank" rel="noopener noreferrer" className={downloadLinkClass}>
          JSON من المصدر الرسمي
        </a>
        <a href={officialPageUrl} target="_blank" rel="noopener noreferrer" className={downloadLinkClass}>
          صفحة البيانات الرسمية
        </a>
      </div>

      {hasRecords && (
        <div className="mt-10">
          <h2 className="font-display text-xl font-bold text-sea-900">البيانات</h2>
          <div className="mt-4">
            <Suspense fallback={<RecordsTableSkeleton />}>
              <RecordsSection datasetId={id} page={page} sortField={sortField} sortDir={sortDir} fields={fields} />
            </Suspense>
          </div>
        </div>
      )}

      <div className="mt-12 border-t border-line-light pt-6">
        {description && (
          <p className="max-w-3xl whitespace-pre-line text-sm leading-7 text-ink/60">{description}</p>
        )}
        <p className="mt-3 text-xs text-ink/40">
          المصدر:{" "}
          <a
            href={officialPageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-pearl decoration-2 underline-offset-4 transition-colors hover:text-coral"
          >
            صفحة هذه المجموعة على data.gov.bh
          </a>{" "}
          — مشروع نبض البحرين مستقل وغير رسمي.
        </p>
      </div>
    </div>
  );
}
