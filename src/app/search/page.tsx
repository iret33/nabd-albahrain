import type { Metadata } from "next";
import { searchDatasets } from "@/lib/queries";
import { DatasetCard } from "@/components/dataset-card";
import { Pagination } from "@/components/pagination";
import { EmptyState } from "@/components/empty-state";
import { SearchForm } from "@/components/search-form";
import { NumberLatin } from "@/components/number-latin";

interface Props {
  searchParams: Promise<{ q?: string; page?: string }>;
}

// Phase 8: explicit alongside the other DB-backed pages (see
// `src/app/(home)/page.tsx`) for certainty — the `searchParams` prop
// already opts this route out of static rendering on its own, but making
// it explicit removes any doubt.
export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const q = (await searchParams).q?.trim() ?? "";
  return q
    ? {
        title: `نتائج البحث عن "${q}" | نبض البحرين`,
        description: `نتائج البحث عن "${q}" في مجموعات البيانات المفتوحة لمملكة البحرين.`,
      }
    : {
        title: "البحث | نبض البحرين",
        description: "ابحث في كل مجموعات البيانات المفتوحة لمملكة البحرين.",
      };
}

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const page = Math.max(1, Number(sp.page) || 1);

  const { items, total, totalPages } = await searchDatasets(q, page);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl font-black text-sea-900">البحث</h1>
      <p className="mt-2 max-w-2xl text-sm leading-7 text-ink/60">
        ابحث في عناوين مجموعات البيانات ووصفها والجهات الناشرة والفئات — من بوابة data.gov.bh
        الرسمية لمملكة البحرين.
      </p>

      <div className="mt-6 max-w-xl">
        <SearchForm initialQuery={q} />
      </div>

      <div className="mt-8">
        {!q ? (
          <EmptyState
            title="ابدأ بكتابة كلمة للبحث"
            description="اكتب عنوان مجموعة بيانات، اسم جهة حكومية، أو موضوعًا في مربع البحث أعلاه."
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="لا توجد نتائج لبحثك — جرّب كلمة أخرى"
            description={`لم نعثر على مجموعات بيانات تطابق "${q}".`}
          />
        ) : (
          <>
            <p className="mb-4 text-sm text-ink/60">
              <NumberLatin value={total} /> نتيجة عن &quot;{q}&quot;
            </p>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((d) => (
                <DatasetCard key={d.id} dataset={d} />
              ))}
            </div>
            <Pagination
              page={page}
              totalPages={totalPages}
              hrefForPage={(p) => `/search?q=${encodeURIComponent(q)}&page=${p}`}
            />
          </>
        )}
      </div>
    </div>
  );
}
