/**
 * schema.org structured data for the dataset page (Google Dataset Search
 * reads `Dataset` markup; the breadcrumb is otherwise visual-only).
 *
 * Pure and dependency-free: the page passes in everything (including the site
 * origin), so the builders are trivial to unit-test and never touch the DB or
 * the environment.
 *
 * Rules worth knowing:
 *  - `jsonLdScript` is the ONLY way the page serializes the object into an
 *    inline <script>. Dataset titles and descriptions come from a third-party
 *    portal, so "</script>" (or an HTML comment opener) in one of them must not
 *    be able to close the tag: "<", ">" and "&" are written as \uXXXX escapes,
 *    which JSON parsers read back as the same characters.
 *  - Every field is optional-tolerant: a missing publisher, license, date or
 *    keyword list drops that property rather than emitting null/empty values
 *    (Google's validator flags empty strings).
 *  - A dataset removed from the portal advertises no `sameAs`/`distribution`:
 *    those official URLs no longer resolve.
 */

export const JSON_LD_MAX_DESCRIPTION = 5000;
export const JSON_LD_MAX_VARIABLES = 20;

const CATALOG = { "@type": "DataCatalog", name: "data.gov.bh", url: "https://www.data.gov.bh" } as const;

const ARABIC_LETTER_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const LATIN_LETTER_RE = /[A-Za-z]/;

/**
 * Collapses whitespace and cuts `text` to at most `max` characters on a word
 * boundary, ending with an ellipsis when it was shortened. A cut that would
 * leave less than half of the budget (one very long word) falls back to a hard
 * cut, and a cut never splits a surrogate pair or leaves dangling punctuation.
 */
export function truncateOnWord(text: string | null | undefined, max: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  if (clean.length <= max) return clean;
  if (max === 1) return "…";

  let cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= (max - 1) / 2) cut = cut.slice(0, lastSpace);
  // Never end on half of a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  cut = cut.replace(/[\s,;:،؛.\-–—]+$/u, "");
  return `${cut}…`;
}

/** JSON for an inline `<script type="application/ld+json">`, safe against `</script>` injection. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "ar" / "en" for whichever scripts the dataset's text actually uses ("ar" when it has neither). */
export function detectLanguages(...texts: Array<string | null | undefined>): string[] {
  const joined = texts.filter(Boolean).join(" ");
  const out: string[] = [];
  if (ARABIC_LETTER_RE.test(joined)) out.push("ar");
  if (LATIN_LETTER_RE.test(joined)) out.push("en");
  return out.length > 0 ? out : ["ar"];
}

export interface DatasetJsonLdInput {
  /** Site origin without a trailing slash, e.g. "https://data.hekkapp.com". */
  siteUrl: string;
  id: string;
  /** The title shown as the page's H1. */
  name: string;
  /** The title in the other language, when there is one. */
  alternateName?: string | null;
  description?: string | null;
  publisher?: string | null;
  theme?: string | null;
  keywords?: readonly string[] | null;
  license?: string | null;
  /** The portal's own "modified" time (NOT our sync time). */
  sourceModified?: Date | string | null;
  /** Absolute URL of the dataset's page on the official portal. */
  officialPageUrl: string;
  csvUrl: string;
  jsonUrl: string;
  /** Field labels (or names) in schema order; the first ~20 become `variableMeasured`. */
  fieldLabels?: readonly string[] | null;
  /** True when the portal no longer lists the dataset. */
  removed?: boolean;
}

/** schema.org `Dataset` for one dataset page. Absent inputs drop their property. */
export function buildDatasetJsonLd(input: DatasetJsonLdInput): Record<string, unknown> {
  const url = `${input.siteUrl}/dataset/${encodeURIComponent(input.id)}`;
  const description = truncateOnWord(input.description, JSON_LD_MAX_DESCRIPTION) || input.name;

  const keywords: string[] = [];
  for (const k of [...(input.keywords ?? []), input.theme ?? ""]) {
    const t = k.trim();
    if (t && !keywords.includes(t)) keywords.push(t);
  }

  const variables: string[] = [];
  for (const label of input.fieldLabels ?? []) {
    const t = label.trim();
    if (t && !variables.includes(t)) variables.push(t);
    if (variables.length >= JSON_LD_MAX_VARIABLES) break;
  }

  const alternateName = input.alternateName?.trim();
  const publisher = input.publisher?.trim();
  const license = input.license?.trim();
  const dateModified = toIso(input.sourceModified);

  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: input.name,
    ...(alternateName && alternateName !== input.name ? { alternateName } : {}),
    description,
    url,
    identifier: input.id,
    ...(publisher ? { creator: { "@type": "Organization", name: publisher } } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(license ? { license } : {}),
    ...(dateModified ? { dateModified } : {}),
    inLanguage: detectLanguages(input.name, input.alternateName, input.description),
    isAccessibleForFree: true,
    includedInDataCatalog: { ...CATALOG },
    ...(variables.length > 0 ? { variableMeasured: variables } : {}),
  };

  if (!input.removed) {
    ld.sameAs = input.officialPageUrl;
    ld.distribution = [
      { "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: input.csvUrl },
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: input.jsonUrl },
    ];
  }
  return ld;
}

export interface BreadcrumbItem {
  name: string;
  /** Absolute URL. */
  url: string;
}

/** schema.org `BreadcrumbList`; empty names are skipped and positions stay consecutive. */
export function buildBreadcrumbJsonLd(items: readonly BreadcrumbItem[]): Record<string, unknown> {
  const kept = items.filter((i) => i.name.trim() !== "");
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: kept.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}
