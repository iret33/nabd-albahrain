import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * What crawlers must not request:
 *
 * - /admin: also marked `robots: { index: false, follow: false }` on its own
 *   pages (belt-and-braces), but Disallow additionally keeps crawlers from
 *   even requesting the login form / dashboard in the first place.
 * - /api/: JSON endpoints, not pages.
 * - /search: a query-string-driven results view with no canonical URL.
 * - The parametrized URL space. Every records-table header is a link to
 *   `?sort=…&dir=…` and the pager emits `?page=N`, which multiplies each of
 *   the ~512 dataset pages into tens of thousands of crawlable URLs, each a
 *   database hit. The same goes for the listing filters (`q`, `sort`,
 *   `chart`, `since`, `publisher`, `theme`) and the in-table search `rq`.
 *   `?page=` stays crawlable on /categories and /publishers (real, bounded
 *   pagination of canonical listings); only dataset pages lose it.
 *
 * Google and Bing both honor `*` wildcards in Disallow paths; a rule that
 * is more specific than `Allow: /` wins for them.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/admin",
          "/api/",
          "/search",
          "/dataset/*?*sort=",
          "/dataset/*?*dir=",
          "/dataset/*?*page=",
          "/dataset/*?*rq=",
          "/categories/*?*sort=",
          "/categories/*?*q=",
          "/categories/*?*chart=",
          "/categories/*?*since=",
          "/categories/*?*publisher=",
          "/publishers/*?*sort=",
          "/publishers/*?*q=",
          "/publishers/*?*chart=",
          "/publishers/*?*since=",
          "/publishers/*?*theme=",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
