/**
 * URL <-> query contract for every dataset listing (search, category,
 * publisher, "what's new", the public API). Pure: no Prisma, no Next.
 *
 * `parseListParams` turns whatever the framework hands a page
 * (`string | string[] | undefined`, repeated keys, 10 MB of garbage) into one
 * well-typed `ListParams`; `listDatasets()` in `queries.ts` consumes it; the
 * `*Href` helpers turn it back into links so filter chips, sort selects and
 * pagers never hand-build query strings (and therefore never drop a filter).
 *
 * URL parameters (all optional):
 *   q          free text, trimmed, max 100 chars; tokenized by `tokenize()`
 *   theme      exact theme name (validated against the real theme list later)
 *   publisher  publisher slug (validated against the real publisher list later)
 *   sort       relevance | updated | title | records
 *   chart      "1" = only datasets that have a chart (alias: hasChart)
 *   since      30d | 1y = source modified within that window
 *   page       1-based, plain digits only
 */

import { MAX_THEME_LENGTH } from "@/lib/cache-config";
import { first, parsePage, parseQuery } from "@/lib/params";
import { tokenize } from "@/lib/search";
import { MAX_PUBLISHER_SLUG_LENGTH } from "@/lib/slugify";

export const LIST_SORTS = ["relevance", "updated", "title", "records"] as const;
export type ListSort = (typeof LIST_SORTS)[number];

export const LIST_SINCE = ["30d", "1y"] as const;
export type ListSince = (typeof LIST_SINCE)[number];

export const MAX_QUERY_LENGTH = 100;
// Theme and publisher-slug caps live in cache-config / slugify so the writer (sync), the lookups and this
// parser share ONE limit each; a theme this parser cut short would no longer be found by an exact lookup.

/** Fully normalized listing parameters. Always produced by `buildListParams`. */
export interface ListParams {
  /** Trimmed, length-capped query text for display ("" when absent). */
  q: string;
  /** Normalized search tokens derived from `q` (at most 6; empty when `q` is too short to search). */
  tokens: string[];
  /** Theme name filter, or null. Not yet validated against the catalog. */
  theme: string | null;
  /** Publisher slug filter, or null. Not yet validated against the catalog. */
  publisher: string | null;
  /** Effective sort: "relevance" only survives when there are tokens to rank by. */
  sort: ListSort;
  hasChart: boolean;
  since: ListSince | null;
  /** 1-based, capped at 10_000 here; clamped to the real last page by the data layer. */
  page: number;
}

/** Loosely typed input for `buildListParams` (every field optional, untrusted). */
export interface ListParamsInput {
  q?: string | null;
  theme?: string | null;
  publisher?: string | null;
  sort?: string | null;
  hasChart?: boolean | null;
  since?: string | null;
  page?: number | null;
}

/** What Next gives a page (`searchParams`) or a route handler (`url.searchParams`). */
export type RawSearchParams = Record<string, string | string[] | undefined> | URLSearchParams;

/** The sort a listing uses when the URL does not say: relevance if searching, else A-Z. */
export function defaultSortFor(tokens: readonly string[]): ListSort {
  return tokens.length > 0 ? "relevance" : "title";
}

function readParam(sp: RawSearchParams, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  // Own properties only: `?__proto__=x` / `constructor` must never resolve to Object.prototype members.
  return Object.prototype.hasOwnProperty.call(sp, key) ? first(sp[key]) : undefined;
}

function cleanOptional(value: string | null | undefined, maxLen: number): string | null {
  const text = typeof value === "string" ? value.trim().slice(0, maxLen) : "";
  return text === "" ? null : text;
}

function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "on", "yes"].includes(value.trim().toLowerCase());
}

/** Normalize loosely typed values into a `ListParams`. Idempotent: `buildListParams(buildListParams(x))` equals the first result. */
export function buildListParams(input: ListParamsInput = {}): ListParams {
  const q = typeof input.q === "string" ? input.q.trim().slice(0, MAX_QUERY_LENGTH) : "";
  const tokens = tokenize(q);

  const requested = (LIST_SORTS as readonly string[]).includes(input.sort ?? "") ? (input.sort as ListSort) : null;
  let sort: ListSort = requested ?? defaultSortFor(tokens);
  if (sort === "relevance" && tokens.length === 0) sort = "title";

  const since = (LIST_SINCE as readonly string[]).includes(input.since ?? "") ? (input.since as ListSince) : null;

  const rawPage = input.page;
  const page =
    typeof rawPage === "number" && Number.isSafeInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, 10_000) : 1;

  return {
    q,
    tokens,
    theme: cleanOptional(input.theme, MAX_THEME_LENGTH),
    publisher: cleanOptional(input.publisher, MAX_PUBLISHER_SLUG_LENGTH),
    sort,
    hasChart: input.hasChart === true,
    since,
    page,
  };
}

/** Parse untrusted URL search params into `ListParams`. Never throws (a missing object means no params). */
export function parseListParams(searchParams: RawSearchParams | null | undefined): ListParams {
  const sp: RawSearchParams = searchParams ?? {};
  return buildListParams({
    q: parseQuery(readParam(sp, "q"), MAX_QUERY_LENGTH),
    theme: readParam(sp, "theme"),
    publisher: readParam(sp, "publisher"),
    sort: readParam(sp, "sort"),
    hasChart: isTruthyFlag(readParam(sp, "chart")) || isTruthyFlag(readParam(sp, "hasChart")),
    since: readParam(sp, "since"),
    page: parsePage(readParam(sp, "page")),
  });
}

/** Parameters a link may leave out because the page's path already carries them (e.g. `/categories/[theme]`). */
export type OmittableListKey = "q" | "theme" | "publisher" | "sort" | "chart" | "since";

/**
 * Serialize listing params back into a query string, leaving out defaults
 * (page 1, the default sort, false/null filters). `overrides` replace values;
 * changing anything other than `page` resets the page to 1 unless `page` is
 * given explicitly, so a changed filter can never land on a now-empty page.
 */
export function listSearchParams(
  params: ListParams,
  overrides: ListParamsInput = {},
  omit: readonly OmittableListKey[] = [],
): URLSearchParams {
  const changedFilter = Object.keys(overrides).some((k) => k !== "page");
  // A sort that was only the default for the *old* query must not stick to a new one
  // (typing a query into a browse page should land on "relevance", not an explicit "title").
  const sortWasDefault = params.sort === defaultSortFor(params.tokens);
  const merged = buildListParams({
    q: params.q,
    theme: params.theme,
    publisher: params.publisher,
    sort: "q" in overrides && !("sort" in overrides) && sortWasDefault ? null : params.sort,
    hasChart: params.hasChart,
    since: params.since,
    page: params.page,
    ...(changedFilter && !("page" in overrides) ? { page: 1 } : {}),
    ...overrides,
  });

  const out = new URLSearchParams();
  const skip = new Set<string>(omit);
  if (merged.q && !skip.has("q")) out.set("q", merged.q);
  if (merged.theme && !skip.has("theme")) out.set("theme", merged.theme);
  if (merged.publisher && !skip.has("publisher")) out.set("publisher", merged.publisher);
  if (merged.sort !== defaultSortFor(merged.tokens) && !skip.has("sort")) out.set("sort", merged.sort);
  if (merged.hasChart && !skip.has("chart")) out.set("chart", "1");
  if (merged.since && !skip.has("since")) out.set("since", merged.since);
  if (merged.page > 1) out.set("page", String(merged.page));
  return out;
}

/** `basePath` plus the serialized params, e.g. `/search?q=health&sort=updated&page=2`. */
export function listHref(
  basePath: string,
  params: ListParams,
  overrides: ListParamsInput = {},
  omit: readonly OmittableListKey[] = [],
): string {
  const qs = listSearchParams(params, overrides, omit).toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Link to another page of the same listing, keeping every filter. */
export function pageHref(
  basePath: string,
  params: ListParams,
  page: number,
  omit: readonly OmittableListKey[] = [],
): string {
  return listHref(basePath, params, { page }, omit);
}

/** Link that drops one active filter (the "x" on a filter chip). */
export function removeFilterHref(
  basePath: string,
  params: ListParams,
  key: OmittableListKey,
  omit: readonly OmittableListKey[] = [],
): string {
  const overrides: ListParamsInput =
    key === "q"
      ? { q: "" }
      : key === "theme"
        ? { theme: null }
        : key === "publisher"
          ? { publisher: null }
          : key === "sort"
            ? { sort: null }
            : key === "chart"
              ? { hasChart: false }
              : { since: null };
  return listHref(basePath, params, overrides, omit);
}

export interface ActiveFilter {
  key: "q" | "theme" | "publisher" | "chart" | "since";
  value: string;
}

/** The filters currently narrowing the list, for rendering removable chips. */
export function activeFilters(params: ListParams, omit: readonly OmittableListKey[] = []): ActiveFilter[] {
  const skip = new Set<string>(omit);
  const out: ActiveFilter[] = [];
  if (params.q && !skip.has("q")) out.push({ key: "q", value: params.q });
  if (params.theme && !skip.has("theme")) out.push({ key: "theme", value: params.theme });
  if (params.publisher && !skip.has("publisher")) out.push({ key: "publisher", value: params.publisher });
  if (params.hasChart && !skip.has("chart")) out.push({ key: "chart", value: "1" });
  if (params.since && !skip.has("since")) out.push({ key: "since", value: params.since });
  return out;
}

const DAY_MS = 86_400_000;

/** Start of the `since` window relative to `now`. */
export function sinceCutoff(since: ListSince, now: Date = new Date()): Date {
  return new Date(now.getTime() - (since === "30d" ? 30 : 365) * DAY_MS);
}
