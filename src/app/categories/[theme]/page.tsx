import Link from "next/link";
import type { Metadata } from "next";
import { getDatasetsByTheme } from "@/lib/queries";
import { themeColor } from "@/lib/theme-colors";
import { DatasetCard } from "@/components/dataset-card";
import { Pagination } from "@/components/pagination";
import { EmptyState } from "@/components/empty-state";
import { NumberLatin } from "@/components/number-latin";

interface Props {
  params: Promise<{ theme: string }>;
  searchParams: Promise<{ page?: string }>;
}

function decodeThemeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const theme = decodeThemeParam((await params).theme);
  return {
    title: `${theme} | نبض البحرين`,
    description: `مجموعات البيانات المفتوحة في فئة ${theme} من بوابة data.gov.bh الرسمية لمملكة البحرين.`,
  };
}

export default async function ThemePage({ params, searchParams }: Props) {
  const theme = decodeThemeParam((await params).theme);
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);

  const { items, total, totalPages } = await getDatasetsByTheme(theme, page);
  const color = themeColor(theme);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <nav aria-label="مسار التنقل" className="text-sm text-ink/60">
        <Link href="/categories" className="rounded transition-colors hover:text-coral">
          الفئات
        </Link>
      </nav>

      <div className="mt-2 flex items-center gap-3">
        <span className="h-8 w-1.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
        <h1 className="font-display text-2xl font-black text-sea-900 sm:text-3xl">{theme}</h1>
      </div>
      <p className="mt-2 text-sm text-ink/60">
        <NumberLatin value={total} /> مجموعة بيانات
      </p>

      <div className="mt-8">
        {items.length === 0 ? (
          <EmptyState
            title="لا توجد مجموعات بيانات في هذه الفئة"
            description="قد تكون هذه الفئة فارغة أو لم تكتمل مزامنتها بعد."
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((d) => (
                <DatasetCard key={d.id} dataset={d} />
              ))}
            </div>
            <Pagination
              page={page}
              totalPages={totalPages}
              hrefForPage={(p) => `/categories/${encodeURIComponent(theme)}?page=${p}`}
            />
          </>
        )}
      </div>
    </div>
  );
}
