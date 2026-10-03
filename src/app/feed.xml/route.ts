/**
 * GET /feed.xml — Atom feed of the 50 datasets the SOURCE modified most
 * recently (same selection and order as /updates). Advertised to readers and
 * crawlers through `alternates.types` in the root metadata.
 *
 * Entry ids are the absolute dataset URLs, so when a dataset is modified again
 * the same entry is reported as updated (not as a duplicate). Titles follow the
 * site (the portal's Arabic title when it has one); the summary is the Arabic
 * sentence generated at sync time, else the plain-text description, cut short.
 * All XML building/escaping is `buildAtomFeed` (unit-tested).
 *
 * `force-dynamic` like every DB-backed route: a build must not need a database.
 * No public Cache-Control: a refresh should reach feed readers' next poll, and
 * readers poll politely on their own.
 */

import { getDatasetById, getPortalStats, getRecentlyUpdated } from "@/lib/queries";
import { ATOM_CONTENT_TYPE, buildAtomFeed, type AtomEntry } from "@/lib/atom";
import { displayTitle, stripHtml } from "@/lib/format";
import { FEED_PATH, FEED_TITLE, SITE_NAME, absoluteUrl, truncateText } from "@/lib/seo";

export const dynamic = "force-dynamic";

const FEED_LIMIT = 50;

export async function GET() {
  try {
    const [recent, stats] = await Promise.all([getRecentlyUpdated({ pageSize: FEED_LIMIT }), getPortalStats()]);
    // The card row has no summary; the detail row is cached per dataset, so these are cache hits.
    const details = await Promise.all(recent.items.map((d) => getDatasetById(d.id)));

    const entries: AtomEntry[] = recent.items.map((d, i) => {
      const detail = details[i];
      const url = absoluteUrl(`/dataset/${encodeURIComponent(d.id)}`);
      return {
        id: url,
        url,
        title: displayTitle(d),
        updated: d.sourceModified,
        summary: truncateText(detail?.summaryAr || stripHtml(detail?.description), 400) || null,
        author: d.publisher,
        category: d.theme,
      };
    });

    const xml = buildAtomFeed({
      selfUrl: absoluteUrl(FEED_PATH),
      siteUrl: absoluteUrl("/updates"),
      title: FEED_TITLE,
      subtitle: "آخر مجموعات البيانات التي حدّثتها بوابة data.gov.bh الرسمية لمملكة البحرين",
      author: SITE_NAME,
      entries,
      limit: FEED_LIMIT,
      fallbackUpdated: stats.lastDataChangeAt ?? new Date(),
    });
    return new Response(xml, { status: 200, headers: { "Content-Type": ATOM_CONTENT_TYPE } });
  } catch (err) {
    console.error("[feed.xml] failed:", err);
    return new Response("feed unavailable", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
