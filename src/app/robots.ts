import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    // /admin is also marked `robots: { index: false, follow: false }` on its
    // own pages (belt-and-braces), but Disallow additionally keeps crawlers
    // from even requesting the login form / dashboard in the first place.
    rules: [{ userAgent: "*", allow: "/", disallow: "/admin" }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
