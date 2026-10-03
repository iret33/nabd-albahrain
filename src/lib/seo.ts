/**
 * Metadata helpers shared by the public pages. Pure (type-only Next imports).
 *
 * Why helpers instead of repeating literals in each page: Next merges page
 * metadata into the layout's SHALLOWLY per top-level key. A page that sets
 * `alternates` (for its canonical) replaces the layout's whole `alternates`
 * object, including the Atom `types` entry, and a page that sets `openGraph`
 * replaces `siteName`/`locale`/`type`. So every page that overrides either
 * builds it through here and keeps those fields.
 */

import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";

export const SITE_NAME = "نبض البحرين";
export const SITE_NAME_EN = "Nabd Al-Bahrain";
export const DEFAULT_TITLE = `${SITE_NAME} | ${SITE_NAME_EN}`;
export const TITLE_TEMPLATE = `%s | ${SITE_NAME}`;
export const SITE_DESCRIPTION =
  "لوحة بيانات عربية مستقلة تعرض بصريًا كل مجموعات البيانات المفتوحة في بوابة data.gov.bh الرسمية لمملكة البحرين.";
export const FEED_PATH = "/feed.xml";
export const FEED_TITLE = `${SITE_NAME} — آخر تحديثات البيانات`;
export const THEME_COLOR = "#0b2027";

/** Absolute URL for a site path ("/updates" -> "https://host/updates"). */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * A meta description: whitespace collapsed, cut at a word boundary to at most
 * `max` characters, "…" appended when it was cut. Search engines show ~155-160
 * characters; dataset descriptions can run to thousands.
 */
export function truncateText(text: string | null | undefined, max = 160): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  // Cut at the last word boundary unless that would throw away most of the text.
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s,.;:،؛\-–—]+$/u, "")}…`;
}

/** The Atom feed advertisement every page carries (see the note at the top about shallow merging). */
const FEED_ALTERNATE = { "application/atom+xml": [{ url: FEED_PATH, title: FEED_TITLE }] };

/** `alternates` with a canonical path (relative to `metadataBase`) and the feed link. */
export function alternatesFor(canonicalPath: string): NonNullable<Metadata["alternates"]> {
  return { canonical: canonicalPath, types: FEED_ALTERNATE };
}

/**
 * The brand card (src/app/opengraph-image.png and twitter-image.png, both 1200x630).
 * The file conventions attach these to every route that does NOT set its own
 * `openGraph`/`twitter`; a page that does replaces the whole object and would
 * lose the image, so the builders below name it explicitly (URLs resolve
 * against `metadataBase`).
 */
export const OG_IMAGE = { url: "/opengraph-image.png", width: 1200, height: 630, alt: `${SITE_NAME} — ${SITE_NAME_EN}` } as const;
export const TWITTER_IMAGE = { url: "/twitter-image.png", width: 1200, height: 630, alt: `${SITE_NAME} — ${SITE_NAME_EN}` } as const;

export function openGraphFor(input: { title: string; description: string; path: string }): NonNullable<Metadata["openGraph"]> {
  return {
    type: "website",
    siteName: SITE_NAME,
    locale: "ar_BH",
    title: input.title === SITE_NAME ? DEFAULT_TITLE : `${input.title} | ${SITE_NAME}`,
    description: input.description,
    url: input.path,
    images: [OG_IMAGE],
  };
}

export const NOINDEX_FOLLOW = { index: false, follow: true } as const;

export interface ListingMetadataInput {
  title: string;
  description: string;
  /** Canonical path of the listing WITHOUT query ("/categories/health"). */
  path: string;
  /** 1-based page actually shown. */
  page?: number;
  /**
   * The URL carries filters/sort/query (or the page has nothing to index):
   * mark it noindex,follow and canonicalize to the plain listing, so the
   * crawlable URL space stays the real, bounded one.
   */
  noindex?: boolean;
}

/**
 * Metadata for a listing page. Canonical rule: the plain path for page 1; the
 * page's own URL (`?page=N`) for page N > 1 (each page is its own document);
 * and always the plain path when `noindex` is set (filtered views fold into the
 * unfiltered listing).
 */
export function listingMetadata(input: ListingMetadataInput): Metadata {
  const page = input.page && input.page > 1 ? input.page : 1;
  const canonical = !input.noindex && page > 1 ? `${input.path}?page=${page}` : input.path;
  const title = page > 1 && !input.noindex ? `${input.title} — صفحة ${page}` : input.title;
  return {
    title,
    description: input.description,
    alternates: alternatesFor(canonical),
    openGraph: openGraphFor({ title, description: input.description, path: canonical }),
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${SITE_NAME}`,
      description: input.description,
      images: [TWITTER_IMAGE],
    },
    ...(input.noindex ? { robots: NOINDEX_FOLLOW } : {}),
  };
}

/**
 * JSON for an inline `<script type="application/ld+json">`. `<`, `>` and `&`
 * (plus the two line separators JavaScript treats as newlines) are written as
 * \u escapes so no string in the data can close the script element.
 */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** schema.org WebSite with a SearchAction (Google's sitelinks search box). */
export function websiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    alternateName: SITE_NAME_EN,
    url: absoluteUrl("/"),
    inLanguage: "ar",
    description: SITE_DESCRIPTION,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${absoluteUrl("/search")}?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
}

export interface BreadcrumbCrumb {
  name: string;
  /** Site path; omit for the current page (the last crumb). */
  path?: string;
}

/** schema.org BreadcrumbList. The first crumb is always the home page. */
export function breadcrumbJsonLd(crumbs: readonly BreadcrumbCrumb[]) {
  const all: BreadcrumbCrumb[] = [{ name: SITE_NAME, path: "/" }, ...crumbs];
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: all.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      ...(crumb.path ? { item: absoluteUrl(crumb.path) } : {}),
    })),
  };
}
