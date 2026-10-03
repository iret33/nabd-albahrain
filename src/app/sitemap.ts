import type { MetadataRoute } from "next";
import { getThemeCounts, getPublisherCounts, getPortalStats, getSitemapDatasets } from "@/lib/queries";
import { isValidPublisherSlug } from "@/lib/cache-config";
import { SITE_URL } from "@/lib/site";

/**
 * Covers every public route: home, /categories, one entry per theme,
 * /publishers, one entry per publisher (deduped by slug — see queries.ts's
 * getPublisherCounts), /updates, /about and one entry per live dataset
 * (datasets the portal removed are excluded). /search is deliberately
 * excluded — it's a query-string-driven results view with no single
 * canonical URL worth indexing without a `q`.
 *
 * `lastModified` is the date the PORTAL last modified the dataset
 * (`sourceModified`), falling back to our sync time only when the portal
 * gave none — our own sync time is bumped for every dataset by a forced
 * sync, which would tell crawlers everything changed. The aggregate pages
 * (home, listings, /updates) use the last time any data changed. No
 * `changeFrequency`/`priority`: crawlers ignore them.
 *
 * Every query behind this goes through the data layer's cache (one entry for
 * the dataset list), so a crawler hitting /sitemap.xml costs no database work
 * between refreshes.
 *
 * `dynamic = "force-dynamic"`: the sitemap is entirely DB-derived and changes
 * as the catalog syncs, and without the export `next build` would prerender it
 * at build time, which needs a reachable `DATABASE_URL` (a build must never
 * depend on a running database; `docker build` failed on exactly this with
 * `PrismaClientInitializationError`). Do not remove the export.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [themes, publishers, datasets, stats] = await Promise.all([
    getThemeCounts(),
    getPublisherCounts(),
    getSitemapDatasets(),
    getPortalStats(),
  ]);

  // Aggregate pages change when any dataset's data changes; omit the date entirely when we cannot tell.
  const aggregateModified = stats.lastDataChangeAt ?? stats.latestSourceModified ?? undefined;
  const withDate = (url: string, lastModified: Date | undefined): MetadataRoute.Sitemap[number] =>
    lastModified ? { url, lastModified } : { url };

  const staticEntries: MetadataRoute.Sitemap = [
    withDate(`${SITE_URL}/`, aggregateModified),
    withDate(`${SITE_URL}/categories`, aggregateModified),
    withDate(`${SITE_URL}/publishers`, aggregateModified),
    withDate(`${SITE_URL}/updates`, aggregateModified),
    { url: `${SITE_URL}/about` },
    { url: `${SITE_URL}/developers` },
  ];

  const themeEntries: MetadataRoute.Sitemap = themes.map((t) =>
    withDate(`${SITE_URL}/categories/${encodeURIComponent(t.theme)}`, aggregateModified),
  );

  // `slugify` never yields an empty or over-long slug any more (Arabic names get a hashed one), so this
  // filter is defence in depth: an invalid slug would be a `<loc>` that is the /publishers index
  // itself (empty) or a page that 404s.
  const publisherEntries: MetadataRoute.Sitemap = publishers
    .filter((p) => isValidPublisherSlug(p.slug))
    .map((p) => withDate(`${SITE_URL}/publishers/${p.slug}`, aggregateModified));

  const datasetEntries: MetadataRoute.Sitemap = datasets.map((d) =>
    withDate(`${SITE_URL}/dataset/${encodeURIComponent(d.id)}`, d.sourceModified ?? d.lastSyncedAt ?? undefined),
  );

  return [...staticEntries, ...themeEntries, ...publisherEntries, ...datasetEntries];
}
