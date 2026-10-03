import type { Metadata } from "next";
import { listDatasets } from "@/lib/queries";
import { listSearchParams, parseListParams, type ListParams, type RawSearchParams } from "@/lib/list-query";
import { listingMetadata } from "@/lib/seo";
import { ListingResults, QueryText } from "@/components/listing-results";
import { SearchForm } from "@/components/search-form";

interface Props {
  searchParams: Promise<Exclude<RawSearchParams, URLSearchParams>>;
}

/**
 * /search is never indexed (`noindex, follow`): it is an unbounded URL space of ad-hoc
 * queries with no canonical form, and the bare page (a prompt to type something) has
 * nothing worth a result slot either. It is NOT blocked in robots.txt on purpose: a
 * Disallow would keep crawlers from ever fetching the page, so they would never see this
 * noindex, and a linked bare URL could stay in the index "though blocked by robots.txt".
 * The title echoes the query, so the noindex also keeps search-spam text injected through
 * a crafted link out of result pages.
 */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const params = parseListParams(await searchParams);
  return params.q
    ? listingMetadata({
        title: `نتائج البحث عن «${params.q}»`,
        description: `نتائج البحث عن «${params.q}» في مجموعات البيانات المفتوحة لمملكة البحرين.`,
        path: "/search",
        noindex: true,
      })
    : listingMetadata({
        title: "البحث",
        description: "ابحث في كل مجموعات البيانات المفتوحة لمملكة البحرين.",
        path: "/search",
        noindex: true,
      });
}

export default async function SearchPage({ searchParams }: Props) {
  const parsed = parseListParams(await searchParams);

  // A bookmarked link can name a theme/publisher that no longer exists. Unlike /categories/[theme]
  // (where the theme IS the page, so it is a 404), a search should still answer: drop the unknown
  // filter, say so, and show what the rest of the query finds.
  let input: ListParams = parsed;
  const ignored: string[] = [];
  let result = await listDatasets(input);
  for (let i = 0; i < 2 && (result.status === "unknown-theme" || result.status === "unknown-publisher"); i++) {
    if (result.status === "unknown-theme") {
      input = { ...input, theme: null };
      ignored.push("الفئة");
    } else {
      input = { ...input, publisher: null };
      ignored.push("الجهة");
    }
    result = await listDatasets(input);
  }

  // Re-searching from the box keeps the active filters (but not the page or the sort).
  const keep = Object.fromEntries(listSearchParams(result.params, { page: 1 }, ["q", "sort"]));

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      {/* [overflow-wrap:anywhere], not just break-words: it also lowers the min-content width, so a pasted
          100-character URL wraps instead of widening the whole page (WCAG 1.4.10 reflow). */}
      <h1 className="font-display text-3xl font-black text-sea-900 [overflow-wrap:anywhere]">
        {result.query ? (
          <>
            نتائج البحث عن <QueryText q={result.query} />
          </>
        ) : (
          "البحث"
        )}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-7 text-ink-muted">
        ابحث في عناوين مجموعات البيانات ووصفها والجهات الناشرة والفئات — من بوابة data.gov.bh
        الرسمية لمملكة البحرين.
      </p>

      <SearchForm className="mt-6 max-w-xl" initialQuery={result.query} hidden={keep} size="md" label="ابحث في مجموعات البيانات" />

      {ignored.length > 0 && (
        <p className="mt-4 w-fit rounded-md bg-coral/10 px-3 py-1.5 text-sm font-medium text-coral">
          تم تجاهل {ignored.join(" و")} غير المعروفة في الرابط.
        </p>
      )}

      <div className="mt-8">
        <ListingResults result={result} basePath="/search" idleWhenUnfiltered />
      </div>
    </div>
  );
}
