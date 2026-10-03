import { Suspense } from "react";
import { getThemeCounts } from "@/lib/queries";
import { listingMetadata } from "@/lib/seo";
import { ThemeTile } from "@/components/theme-tile";
import { EmptyState } from "@/components/empty-state";
import { ThemeTileGridSkeleton } from "@/components/skeletons";

export const metadata = listingMetadata({
  title: "الفئات",
  description: "تصفح كل فئات مجموعات البيانات المفتوحة في مملكة البحرين حسب الموضوع.",
  path: "/categories",
});

/**
 * No route-level loading.tsx here (or on /publishers): a loading.tsx at this
 * segment would also wrap the child route /categories/[theme] in Suspense and
 * turn its `notFound()` into a soft 200. The grid streams from its own boundary.
 */
async function ThemeGrid() {
  const themes = await getThemeCounts();
  if (themes.length === 0) {
    return (
      <EmptyState
        title="لا توجد فئات بعد"
        description="لم تُستورد بيانات الفئات من data.gov.bh حتى الآن. عد لاحقًا بعد اكتمال المزامنة."
      />
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {themes.map((t) => (
        <li key={t.theme}>
          <ThemeTile theme={t.theme} count={t.count} />
        </li>
      ))}
    </ul>
  );
}

export default function CategoriesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <h1 className="font-display text-3xl font-black text-sea-900">الفئات</h1>
      <p className="mt-2 max-w-2xl text-sm leading-7 text-ink-muted">
        كل مجموعات البيانات المفتوحة في بوابة data.gov.bh مصنّفة حسب الموضوع — اختر فئة
        لاستعراض مجموعاتها.
      </p>

      <div className="mt-8">
        <Suspense fallback={<ThemeTileGridSkeleton />}>
          <ThemeGrid />
        </Suspense>
      </div>
    </div>
  );
}
