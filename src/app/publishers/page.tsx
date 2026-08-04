import type { Metadata } from "next";
import { getPublisherCounts } from "@/lib/queries";
import { PublisherTile } from "@/components/publisher-tile";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = {
  title: "الجهات الحكومية | نبض البحرين",
  description: "كل الجهات الحكومية الناشرة لبيانات مفتوحة في بوابة data.gov.bh لمملكة البحرين.",
};

// Phase 8 fix: without this, `next build` tries to statically prerender
// this DB-backed route at *build* time, which requires a live DATABASE_URL
// — broke the Docker build. See the longer explanation on `src/app/(home)/page.tsx`.
export const dynamic = "force-dynamic";

export default async function PublishersPage() {
  const publishers = await getPublisherCounts();

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl font-black text-sea-900">الجهات الحكومية</h1>
      <p className="mt-2 max-w-2xl text-sm leading-7 text-ink/60">
        كل الجهات الحكومية التي تنشر مجموعات بيانات مفتوحة في بوابة data.gov.bh — اختر جهة
        لاستعراض مجموعاتها.
      </p>

      <div className="mt-8">
        {publishers.length === 0 ? (
          <EmptyState
            title="لا توجد جهات بعد"
            description="لم تُستورد بيانات الجهات الناشرة من data.gov.bh حتى الآن. عد لاحقًا بعد اكتمال المزامنة."
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {publishers.map((p) => (
              <PublisherTile key={p.slug} slug={p.slug} name={p.name} count={p.count} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
