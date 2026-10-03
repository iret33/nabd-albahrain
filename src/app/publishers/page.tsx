import { Suspense } from "react";
import { getPublisherCounts } from "@/lib/queries";
import { listingMetadata } from "@/lib/seo";
import { PublisherTile } from "@/components/publisher-tile";
import { EmptyState } from "@/components/empty-state";
import { ThemeTileGridSkeleton } from "@/components/skeletons";

export const metadata = listingMetadata({
  title: "الجهات الحكومية",
  description: "كل الجهات الحكومية الناشرة لبيانات مفتوحة في بوابة data.gov.bh لمملكة البحرين.",
  path: "/publishers",
});

/** Streams from its own boundary; no route-level loading.tsx (it would soften the 404 of /publishers/[slug]). */
async function PublisherGrid() {
  const publishers = await getPublisherCounts();
  if (publishers.length === 0) {
    return (
      <EmptyState
        title="لا توجد جهات بعد"
        description="لم تُستورد بيانات الجهات الناشرة من data.gov.bh حتى الآن. عد لاحقًا بعد اكتمال المزامنة."
      />
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {publishers.map((p) => (
        <li key={p.slug}>
          <PublisherTile slug={p.slug} name={p.name} count={p.count} />
        </li>
      ))}
    </ul>
  );
}

export default function PublishersPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <h1 className="font-display text-3xl font-black text-sea-900">الجهات الحكومية</h1>
      <p className="mt-2 max-w-2xl text-sm leading-7 text-ink-muted">
        كل الجهات الحكومية التي تنشر مجموعات بيانات مفتوحة في بوابة data.gov.bh — اختر جهة
        لاستعراض مجموعاتها.
      </p>

      <div className="mt-8">
        <Suspense fallback={<ThemeTileGridSkeleton />}>
          <PublisherGrid />
        </Suspense>
      </div>
    </div>
  );
}
