import Link from "next/link";
import {
  getPortalStats,
  getThemeCounts,
  getLatestDatasets,
  getFeaturedDataset,
  asVizConfig,
  asChartData,
} from "@/lib/queries";
import { extractFeaturedMetric } from "@/lib/chart-data";
import { themeColor } from "@/lib/theme-colors";
import { formatDateAr } from "@/lib/format";
import { featuredEntries } from "@/config/featured";
import { HeroStatBand } from "@/components/hero-stat-band";
import { PearlLattice } from "@/components/pearl-lattice";
import { NumberLatin } from "@/components/number-latin";
import { ThemeChip } from "@/components/theme-chip";
import { DatasetCard } from "@/components/dataset-card";
import { EmptyState } from "@/components/empty-state";
import { Sparkline } from "@/components/charts/sparkline";

/**
 * Phase 8 fix: this page reads Postgres directly (via the `unstable_cache`
 * layer in `@/lib/queries`, tagged for `revalidateTag()` invalidation —
 * see the sync API writeup below), which is exactly the pattern Next.js
 * documents for a *statically rendered* page with tag-based revalidation.
 * Without an explicit `dynamic` export, `next build` therefore tried to
 * fully prerender this route as static HTML at *build* time, which
 * requires a live, migrated `DATABASE_URL` reachable during the build —
 * confirmed live: `docker build` failed with `PrismaClientInitializationError:
 * Environment variable not found: DATABASE_URL` prerendering `/`. A build
 * step must never depend on a running production database (the DB may not
 * even have this schema applied yet — `docker/entrypoint.sh` runs
 * `prisma migrate deploy` at *container start*, after the image is
 * already built). Forcing this dynamic doesn't lose the caching story —
 * `unstable_cache()`'s Data Cache entries and `revalidateTag()` both work
 * identically on a dynamically-rendered route; only the outer page shell
 * renders per-request instead of being reused as static output, which is
 * cheap next to the actual DB reads it wraps.
 */
export const dynamic = "force-dynamic";

async function FeaturedStatsBand() {
  const results = await Promise.all(
    featuredEntries.map(async (entry) => {
      const dataset = await getFeaturedDataset(entry.datasetId);
      if (!dataset) return null; // configured id not synced yet — skip, don't crash
      const vizConfig = asVizConfig(dataset.vizConfig);
      const chartData = asChartData(dataset.chartData);
      const metric = extractFeaturedMetric(vizConfig, chartData);
      if (!metric) return null; // no usable trend yet — skip this entry
      return { entry, dataset, metric, color: themeColor(dataset.theme) };
    }),
  );
  const items = results.filter((r): r is NonNullable<typeof r> => r !== null);
  if (items.length === 0) return null;

  return (
    <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <h2 className="font-display text-2xl font-bold text-sea-900">مؤشرات مختارة</h2>
      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(({ entry, dataset, metric, color }) => (
          <Link
            key={dataset.id}
            href={`/dataset/${encodeURIComponent(dataset.id)}`}
            className="rounded-2xl border border-line-light bg-white p-5 shadow-sm transition-all hover:-translate-y-[3px] hover:shadow-md"
          >
            <p className="text-xs font-medium text-ink/50">{entry.metricLabelAr}</p>
            <p className="mt-2 font-display text-3xl font-black text-sea-900">
              <NumberLatin value={metric.value} />
              {metric.unit && <span className="mr-1.5 text-sm font-medium text-ink/50">{metric.unit}</span>}
            </p>
            <p className="mt-1 text-xs text-ink/40">
              آخر بيانات: <NumberLatin value={metric.period} />
            </p>
            <div className="mt-3">
              <Sparkline points={metric.points} color={color} />
            </div>
            <p className="mt-3 line-clamp-1 text-xs text-ink/50">{dataset.titleClean}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

async function CategoryRail() {
  const themes = await getThemeCounts();
  if (themes.length === 0) return null;

  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-display text-2xl font-bold text-sea-900">تصفح حسب الفئة</h2>
        <Link href="/categories" className="shrink-0 rounded text-sm font-medium text-coral hover:underline">
          عرض الكل
        </Link>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        {themes.map((t) => (
          <ThemeChip key={t.theme} theme={t.theme} count={t.count} />
        ))}
      </div>
    </section>
  );
}

async function LatestDatasetsSection() {
  const datasets = await getLatestDatasets();

  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h2 className="font-display text-2xl font-bold text-sea-900">الأحدث تحديثاً</h2>
      {datasets.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="لا توجد بيانات محدثة بعد"
            description="لم تكتمل مزامنة أي مجموعة بيانات حتى الآن. عد لاحقًا لعرض أحدث التحديثات."
          />
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {datasets.map((d) => (
            <DatasetCard key={d.id} dataset={d} />
          ))}
        </div>
      )}
    </section>
  );
}

export default async function Home() {
  const stats = await getPortalStats();
  const isEmpty = stats.totalDatasets === 0;

  return (
    <>
      <section className="bg-sea-900 text-sand-50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <p className="font-display text-sm font-bold tracking-wide text-pearl">لوحة بيانات مستقلة</p>
          <h1 className="mt-3 max-w-2xl font-display text-3xl font-black leading-tight sm:text-5xl">
            نبض البحرين
          </h1>
          <p className="mt-4 max-w-xl text-base text-sand-100/80 sm:text-lg">
            لوحة بيانات عربية مستقلة تعرض بصريًا كل مجموعات البيانات المفتوحة في بوابة
            data.gov.bh الرسمية لمملكة البحرين — من الاقتصاد والصحة إلى البيئة والسياحة، في
            مكان واحد.
          </p>

          {isEmpty ? (
            <div className="mt-10 rounded-2xl border border-line-dark bg-sea-800/60 px-6 py-8 text-center">
              <p className="font-display text-lg font-bold text-pearl">لم تبدأ المزامنة بعد</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-sand-100/70">
                لم تُستورد أي بيانات من data.gov.bh حتى الآن. شغّل محرك المزامنة لعرض
                الإحصائيات الحقيقية هنا.
              </p>
            </div>
          ) : (
            <HeroStatBand
              items={[
                { label: "مجموعات البيانات", value: <NumberLatin value={stats.totalDatasets} /> },
                { label: "الجهات الحكومية", value: <NumberLatin value={stats.publisherCount} /> },
                { label: "السجلات المخزّنة", value: <NumberLatin value={stats.totalRecords} /> },
                {
                  label: "آخر تحديث",
                  value: stats.lastSync
                    ? formatDateAr(stats.lastSync.finishedAt ?? stats.lastSync.startedAt)
                    : "—",
                },
              ]}
            />
          )}
        </div>
      </section>

      <PearlLattice />

      {isEmpty ? (
        <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <EmptyState
            title="لوحة فارغة حتى الآن"
            description="بمجرد تشغيل أول مزامنة مع بوابة data.gov.bh، ستظهر هنا الفئات والمجموعات ومؤشراتها."
          />
        </section>
      ) : (
        <>
          <FeaturedStatsBand />
          <CategoryRail />
          <LatestDatasetsSection />
        </>
      )}

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="rounded-3xl bg-sea-800 px-8 py-12 text-center text-sand-50 sm:px-16">
          <h2 className="font-display text-2xl font-bold sm:text-3xl">استكشف كل الفئات</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-sand-100/70 sm:text-base">
            من الاقتصاد والصحة إلى البيئة والسياحة — تصفح جميع مجموعات البيانات الحكومية
            المفتوحة في مكان واحد.
          </p>
          <Link
            href="/categories"
            className="mt-6 inline-flex items-center justify-center rounded-full bg-pearl px-6 py-3 text-sm font-bold text-sea-900 transition-transform hover:scale-105"
          >
            تصفح كل الفئات
          </Link>
        </div>
      </section>
    </>
  );
}
