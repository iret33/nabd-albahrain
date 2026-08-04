import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { getThemeCounts, getPublisherCounts } from "@/lib/queries";
import { SITE_URL } from "@/lib/site";

/**
 * Covers every public route per the spec: home, /categories, one entry
 * per theme, /publishers, one entry per publisher (deduped by slug — see
 * queries.ts's getPublisherCounts), and one entry per dataset. /search is
 * deliberately excluded — it's a query-string-driven results view with no
 * single canonical URL worth indexing without a `q`. /about is included
 * as a normal low-priority static page even though the spec's list
 * doesn't name it explicitly, since it's a real crawlable page.
 *
 * `dynamic = "force-dynamic"` (Phase 8 fix — this route had no such
 * export before and Next.js therefore tried to prerender it as static
 * output at *build* time, which requires a live `DATABASE_URL` to be
 * reachable during `next build`/`docker build` — a build step should
 * never depend on a running production database, and indeed this broke
 * the Phase 8 Docker build outright: `next build` failed prerendering
 * `/sitemap.xml` with `PrismaClientInitializationError: Environment
 * variable not found: DATABASE_URL`, since no DB is (or should be)
 * reachable inside the image build. Forcing this dynamic also happens to
 * be the more correct behavior anyway — the sitemap is entirely
 * DB-derived and changes as the catalog syncs, so it should never have
 * been baked in as static output from whatever data happened to exist at
 * build time.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [themes, publishers, datasets] = await Promise.all([
    getThemeCounts(),
    getPublisherCounts(),
    prisma.dataset.findMany({
      select: { id: true, sourceModified: true, lastSyncedAt: true },
    }),
  ]);

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/categories`, changeFrequency: "daily", priority: 0.8 },
    { url: `${SITE_URL}/publishers`, changeFrequency: "daily", priority: 0.8 },
    { url: `${SITE_URL}/about`, changeFrequency: "monthly", priority: 0.3 },
  ];

  const themeEntries: MetadataRoute.Sitemap = themes.map((t) => ({
    url: `${SITE_URL}/categories/${encodeURIComponent(t.theme)}`,
    changeFrequency: "daily",
    priority: 0.6,
  }));

  const publisherEntries: MetadataRoute.Sitemap = publishers.map((p) => ({
    url: `${SITE_URL}/publishers/${p.slug}`,
    changeFrequency: "daily",
    priority: 0.6,
  }));

  const datasetEntries: MetadataRoute.Sitemap = datasets.map((d) => {
    const lastModified = d.lastSyncedAt ?? d.sourceModified ?? undefined;
    return {
      url: `${SITE_URL}/dataset/${encodeURIComponent(d.id)}`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: "daily" as const,
      priority: 0.5,
    };
  });

  return [...staticEntries, ...themeEntries, ...publisherEntries, ...datasetEntries];
}
