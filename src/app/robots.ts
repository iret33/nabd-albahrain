import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * What crawlers must not request:
 *
 * - /admin: also marked `robots: { index: false, follow: false }` on its own
 *   pages (belt-and-braces), but Disallow additionally keeps crawlers from
 *   even requesting the login form / dashboard in the first place.
 * - /api/: JSON endpoints, not pages.
 *
 * Everything else is crawlable ON PURPOSE, including the sorted / filtered /
 * paged / searched variants (`/search`, `?sort=`, `?q=`, `?chart=`, `?since=`,
 * `?publisher=`, `?theme=`, a dataset's `?page=`/`?dir=`/`?rq=`). Those used to
 * be Disallowed as well, which defeated the page-level `noindex, follow` + canonical
 * they all carry: a crawler that obeys a Disallow never FETCHES the page, so it never
 * sees the noindex, and a bare URL that is linked from elsewhere (a keyword chip, the
 * WebSite SearchAction) can stay indexed "though blocked by robots.txt" for good. One
 * mechanism per URL class, and for these it is the meta robots tag: the page is
 * fetched, says "do not index me, my canonical is the plain listing", and drops out.
 *
 * The crawl cost this exposes is bounded elsewhere: the records table and pager
 * links are `rel="nofollow"`, so a crawler only reaches those URLs through an
 * external link; a sorted / searched dataset view takes one of a few expensive-query
 * slots and degrades instead of queueing (`slot-limiter.ts`); and the listings'
 * reads are cache-backed. If crawl load on those ever matters, add a Disallow for the
 * CLASS only after Search Console shows it deindexed, never while it is the only
 * thing hiding a noindex.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
