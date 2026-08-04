import Link from "next/link";
import type { Metadata } from "next";
import { getDatasetsByPublisherSlug } from "@/lib/queries";
import { DatasetCard } from "@/components/dataset-card";
import { Pagination } from "@/components/pagination";
import { EmptyState } from "@/components/empty-state";
import { NumberLatin } from "@/components/number-latin";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const { publisherName } = await getDatasetsByPublisherSlug(slug, 1);
  if (!publisherName) return { title: "جهة غير معروفة | نبض البحرين" };
  return {
    title: `${publisherName} | نبض البحرين`,
    description: `مجموعات البيانات المفتوحة الصادرة عن ${publisherName} في بوابة data.gov.bh الرسمية لمملكة البحرين.`,
  };
}

/**
 * Same visual pattern as /categories/[theme] — including its "unknown
 * value renders a plain-Arabic empty state instead of a 404" behavior
 * (see the note in skeletons.tsx / README's "Public pages" section on why
 * a route-level `loading.tsx` and `notFound()` don't mix). An unmatched
 * slug is genuinely ambiguous to tell apart from "a real publisher with
 * zero synced datasets" from the URL alone, so both degrade the same way.
 */
export default async function PublisherPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);

  const { items, total, totalPages, publisherName } = await getDatasetsByPublisherSlug(slug, page);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <nav aria-label="مسار التنقل" className="text-sm text-ink/60">
        <Link href="/publishers" className="rounded transition-colors hover:text-coral">
          الجهات الحكومية
        </Link>
      </nav>

      <h1 className="mt-2 font-display text-2xl font-black text-sea-900 sm:text-3xl">
        {publisherName ?? "جهة غير معروفة"}
      </h1>
      <p className="mt-2 text-sm text-ink/60">
        <NumberLatin value={total} /> مجموعة بيانات
      </p>

      <div className="mt-8">
        {items.length === 0 ? (
          <EmptyState
            title="لا توجد مجموعات بيانات لهذه الجهة"
            description="قد تكون هذه الجهة غير معروفة أو لم تكتمل مزامنة بياناتها بعد."
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((d) => (
                <DatasetCard key={d.id} dataset={d} />
              ))}
            </div>
            <Pagination page={page} totalPages={totalPages} hrefForPage={(p) => `/publishers/${slug}?page=${p}`} />
          </>
        )}
      </div>
    </div>
  );
}
