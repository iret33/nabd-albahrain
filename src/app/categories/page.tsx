import type { Metadata } from "next";
import { getThemeCounts } from "@/lib/queries";
import { ThemeTile } from "@/components/theme-tile";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = {
  title: "الفئات | نبض البحرين",
  description: "تصفح كل فئات مجموعات البيانات المفتوحة في مملكة البحرين حسب الموضوع.",
};

// Phase 8 fix: without this, `next build` tries to statically prerender
// this DB-backed route at *build* time, which requires a live DATABASE_URL
// — broke the Docker build. See the longer explanation on `src/app/(home)/page.tsx`.
export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const themes = await getThemeCounts();

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl font-black text-sea-900">الفئات</h1>
      <p className="mt-2 max-w-2xl text-sm leading-7 text-ink/60">
        كل مجموعات البيانات المفتوحة في بوابة data.gov.bh مصنّفة حسب الموضوع — اختر فئة
        لاستعراض مجموعاتها.
      </p>

      <div className="mt-8">
        {themes.length === 0 ? (
          <EmptyState
            title="لا توجد فئات بعد"
            description="لم تُستورد بيانات الفئات من data.gov.bh حتى الآن. عد لاحقًا بعد اكتمال المزامنة."
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {themes.map((t) => (
              <ThemeTile key={t.theme} theme={t.theme} count={t.count} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
