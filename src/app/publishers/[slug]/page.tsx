import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { THEME_PAGE_SIZE, findPublisher, findTheme, listDatasets } from "@/lib/queries";
import { activeFilters, parseListParams, type RawSearchParams } from "@/lib/list-query";
import { clampPage, totalPagesFor } from "@/lib/page-math";
import { breadcrumbJsonLd, jsonLd, listingMetadata, truncateText } from "@/lib/seo";
import { Bidi } from "@/components/bidi";
import { Breadcrumb } from "@/components/breadcrumb";
import { ListingResults } from "@/components/listing-results";
import { NumberLatin } from "@/components/number-latin";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Exclude<RawSearchParams, URLSearchParams>>;
}

const publisherPath = (slug: string) => `/publishers/${slug}`;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  // The slug is checked against the cached publisher list (never reflected unchecked into metadata).
  const publisher = await findPublisher((await params).slug);
  if (!publisher) return { title: "جهة غير معروفة", robots: { index: false } };

  const lp = parseListParams(await searchParams);
  const filtered = activeFilters(lp, ["publisher"]).length > 0 || lp.sort !== "title";
  const page = clampPage(lp.page, totalPagesFor(publisher.count, THEME_PAGE_SIZE));
  return listingMetadata({
    title: publisher.name,
    description: truncateText(
      `مجموعات البيانات المفتوحة الصادرة عن ${publisher.name} (${publisher.count} مجموعة) في بوابة data.gov.bh الرسمية لمملكة البحرين.`,
    ),
    path: publisherPath(publisher.slug),
    page,
    noindex: filtered,
  });
}

/**
 * Same shape as /categories/[theme]: the slug is checked against the cached publisher list
 * first (a true 404 for an unknown one), and there is no loading.tsx or <Suspense> for the
 * same two reasons (it would soften the 404, and the filter bar/pager must work without JS).
 */
export default async function PublisherPage({ params, searchParams }: Props) {
  const publisher = await findPublisher((await params).slug);
  if (!publisher) notFound();

  const lp = parseListParams(await searchParams);
  const theme = lp.theme ? await findTheme(lp.theme) : null;
  const result = await listDatasets({ ...lp, publisher: publisher.slug, theme: theme ? theme.theme : null });

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(breadcrumbJsonLd([{ name: "الجهات الحكومية", path: "/publishers" }, { name: publisher.name }])),
        }}
      />
      <Breadcrumb
        items={[
          { label: "الرئيسية", href: "/" },
          { label: "الجهات الحكومية", href: "/publishers" },
          { label: publisher.name },
        ]}
      />

      <h1 className="mt-2 font-display text-2xl font-black text-sea-900 sm:text-3xl">
        <Bidi text={publisher.name} />
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        <NumberLatin value={publisher.count} /> مجموعة بيانات
      </p>

      <div className="mt-8">
        <ListingResults
          result={result}
          basePath={publisherPath(publisher.slug)}
          omit={["publisher"]}
          showQuery
          queryLabel="ابحث في مجموعات هذه الجهة"
          countOnlyWhenFiltered
        />
      </div>
    </div>
  );
}
