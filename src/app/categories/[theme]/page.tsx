import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { THEME_PAGE_SIZE, findPublisher, findTheme, listDatasets } from "@/lib/queries";
import { activeFilters, parseListParams, type RawSearchParams } from "@/lib/list-query";
import { clampPage, totalPagesFor } from "@/lib/page-math";
import { breadcrumbJsonLd, jsonLd, listingMetadata, truncateText } from "@/lib/seo";
import { themeColor } from "@/lib/theme-colors";
import { Bidi } from "@/components/bidi";
import { Breadcrumb } from "@/components/breadcrumb";
import { ListingResults } from "@/components/listing-results";
import { NumberLatin } from "@/components/number-latin";

interface Props {
  params: Promise<{ theme: string }>;
  searchParams: Promise<Exclude<RawSearchParams, URLSearchParams>>;
}

function decodeThemeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const themePath = (theme: string) => `/categories/${encodeURIComponent(theme)}`;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  // Only a REAL theme (the cached theme list) may reach the title or a canonical: an unknown
  // segment is a 404 and must not echo attacker-chosen text into metadata.
  const theme = await findTheme(decodeThemeParam((await params).theme));
  if (!theme) return { title: "فئة غير معروفة", robots: { index: false } };

  const lp = parseListParams(await searchParams);
  const filtered = activeFilters(lp, ["theme"]).length > 0 || lp.sort !== "title";
  // Same clamp the page applies: ?page=9999 canonicalizes to the real last page, not to itself.
  const page = clampPage(lp.page, totalPagesFor(theme.count, THEME_PAGE_SIZE));
  return listingMetadata({
    title: theme.theme,
    description: truncateText(
      `مجموعات البيانات المفتوحة في فئة ${theme.theme} (${theme.count} مجموعة) من بوابة data.gov.bh الرسمية لمملكة البحرين.`,
    ),
    path: themePath(theme.theme),
    page,
    noindex: filtered,
  });
}

/**
 * The theme is validated against the cached theme list before anything else, so an unknown
 * theme is a genuine HTTP 404. There is deliberately no loading.tsx and no <Suspense> here:
 * either one commits a 200 before `notFound()` can run (see components/skeletons.tsx), and
 * streamed content stays hidden for a browser without JavaScript, while this page's filter
 * bar and pager are plain GET forms and links that must work without it. The reads are
 * cache-backed list queries, so there is nothing slow worth a skeleton.
 */
export default async function ThemePage({ params, searchParams }: Props) {
  const theme = await findTheme(decodeThemeParam((await params).theme));
  if (!theme) notFound();

  const lp = parseListParams(await searchParams);
  // A publisher filter from the URL must be a real one (cached list) before it reaches a query.
  const publisher = lp.publisher ? await findPublisher(lp.publisher) : null;
  const result = await listDatasets({ ...lp, theme: theme.theme, publisher: publisher ? lp.publisher : null });
  const color = themeColor(theme.theme);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(breadcrumbJsonLd([{ name: "الفئات", path: "/categories" }, { name: theme.theme }])),
        }}
      />
      <Breadcrumb
        items={[
          { label: "الرئيسية", href: "/" },
          { label: "الفئات", href: "/categories" },
          { label: theme.theme },
        ]}
      />

      <div className="mt-2 flex items-center gap-3">
        <span className="h-8 w-1.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
        <h1 className="font-display text-2xl font-black text-sea-900 sm:text-3xl">
          <Bidi text={theme.theme} />
        </h1>
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        <NumberLatin value={theme.count} /> مجموعة بيانات
      </p>

      {/* [overflow-wrap:anywhere]: an unbroken ?q= echoed by the active-query chip must wrap, not widen the page (see /search). */}
      <div className="mt-8 [overflow-wrap:anywhere]">
        <ListingResults
          result={result}
          basePath={themePath(theme.theme)}
          omit={["theme"]}
          showQuery
          queryLabel="ابحث في هذه الفئة"
          countOnlyWhenFiltered
        />
      </div>
    </div>
  );
}
