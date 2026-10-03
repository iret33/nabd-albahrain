/**
 * Small pure helpers behind the dataset page (`src/app/dataset/[id]`): the
 * records-table URL space, SEO decisions that depend on it, the staleness
 * rule, the official-portal links and a few Arabic labels. No DOM, Prisma or
 * Next imports, so each rule is unit-testable on its own.
 */

import { first, parsePage, parseQuery } from "@/lib/params";
import { MAX_RECORDS_QUERY_LENGTH } from "@/lib/records-query";

// ---------------------------------------------------------------------------
// Records table URL state
// ---------------------------------------------------------------------------

type RawParam = string | string[] | undefined | null;

export interface RecordsParams {
  /** 1-based; the data layer clamps it to the last real page. */
  page: number;
  /** Column to sort by (validated against the dataset's own fields by the data layer). */
  sort: string | null;
  /** `null` = not specified in the URL (ascending is the default). */
  dir: "asc" | "desc" | null;
  /** In-table search text (max 60 characters), or null. */
  rq: string | null;
}

/** Longest `?sort=` value looked at; matches `MAX_SORT_FIELD_LENGTH` in records-query. */
const MAX_SORT_PARAM = 128;

/**
 * Defensive parse of `?page=&sort=&dir=&rq=`: Next hands pages
 * `string | string[] | undefined`, and `?sort=a&sort=b` is an array at runtime.
 */
export function parseRecordsParams(raw: Record<string, RawParam> | null | undefined): RecordsParams {
  const sp = raw ?? {};
  const sort = first(sp.sort)?.trim() ?? "";
  const dirRaw = first(sp.dir);
  const rq = parseQuery(sp.rq, MAX_RECORDS_QUERY_LENGTH);
  return {
    page: parsePage(sp.page),
    sort: sort !== "" && sort.length <= MAX_SORT_PARAM ? sort : null,
    dir: dirRaw === "asc" || dirRaw === "desc" ? dirRaw : null,
    rq: rq !== "" ? rq : null,
  };
}

/**
 * True when the URL asks for anything but the default first page of the
 * default view. Every such URL is a distinct, cold-cache DB query and an
 * endless crawl space, so they are `noindex` (canonical stays /dataset/<id>).
 */
export function isRefinedRecordsView(p: RecordsParams): boolean {
  return p.page > 1 || p.sort !== null || p.dir !== null || p.rq !== null;
}

export interface RecordsViewState {
  page?: number | null;
  sort?: string | null;
  dir?: "asc" | "desc" | null;
  rq?: string | null;
}

/**
 * `/dataset/<id>?rq=&sort=&dir=&page=#records` for a view state. Defaults are
 * left out (page 1, no sort, no search) so the shortest URL is also the
 * canonical one; the fragment keeps the viewport on the table after a click.
 */
export function recordsHref(datasetId: string, state: RecordsViewState = {}): string {
  const params = new URLSearchParams();
  if (state.rq) params.set("rq", state.rq);
  if (state.sort) {
    params.set("sort", state.sort);
    params.set("dir", state.dir === "desc" ? "desc" : "asc");
  }
  if (state.page && state.page > 1) params.set("page", String(Math.trunc(state.page)));
  const query = params.toString();
  return `/dataset/${encodeURIComponent(datasetId)}${query ? `?${query}` : ""}#records`;
}

/** The "from-to of total" window shown to screen readers and under the table. */
export function recordsRange(page: number, pageSize: number, total: number, rowCount: number): { from: number; to: number } {
  if (rowCount <= 0 || total <= 0) return { from: 0, to: 0 };
  const from = (Math.max(1, page) - 1) * pageSize + 1;
  return { from, to: Math.min(total, from + rowCount - 1) };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** A dataset not re-checked against the portal for this long is flagged "may be outdated". */
export const STALE_AFTER_HOURS = 48;

/**
 * Whether to show the "data may be outdated" chip. The reference time is the
 * last check against the portal, falling back to the last sync for rows that
 * predate `lastCheckedAt`; a dataset that was never synced is not "stale", it
 * simply has no data yet (the page says so separately).
 */
export function isStale(
  lastCheckedAt: Date | null | undefined,
  lastSyncedAt: Date | null | undefined,
  now: Date = new Date(),
  thresholdHours: number = STALE_AFTER_HOURS,
): boolean {
  const reference = lastCheckedAt ?? lastSyncedAt;
  if (!reference || Number.isNaN(reference.getTime())) return false;
  return now.getTime() - reference.getTime() > thresholdHours * 3_600_000;
}

// ---------------------------------------------------------------------------
// Official portal links (never proxied: the browser goes straight to data.gov.bh)
// ---------------------------------------------------------------------------

const ODS_PUBLIC_BASE = "https://data.gov.bh/api/explore/v2.1";

export function officialLinks(datasetId: string): { csvUrl: string; jsonUrl: string; officialPageUrl: string } {
  const id = encodeURIComponent(datasetId);
  return {
    csvUrl: `${ODS_PUBLIC_BASE}/catalog/datasets/${id}/exports/csv?use_labels=true`,
    jsonUrl: `${ODS_PUBLIC_BASE}/catalog/datasets/${id}/exports/json`,
    officialPageUrl: `https://www.data.gov.bh/explore/dataset/${id}/`,
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const FIELD_TYPE_LABELS: Record<string, string> = {
  text: "نص",
  int: "عدد صحيح",
  double: "عدد عشري",
  date: "تاريخ",
  datetime: "تاريخ ووقت",
  boolean: "منطقي",
  geo_point_2d: "موقع جغرافي",
  geo_shape: "شكل جغرافي",
  file: "ملف",
};

/** Arabic name of an ODS field type. Unknown types are treated as text, as the schema contract says. */
export function fieldTypeLabelAr(type: string | null | undefined): string {
  const key = (type ?? "text").toLowerCase();
  return FIELD_TYPE_LABELS[key] ?? FIELD_TYPE_LABELS.text;
}

/**
 * "en" when the text has Latin letters and no Arabic ones, so a screen reader
 * switches voice for an English dataset title; mixed Arabic/Latin text (an
 * Arabic title with an English acronym) stays unlabeled and relies on `dir="auto"`.
 */
export function langOf(text: string | null | undefined): "en" | undefined {
  if (!text) return undefined;
  return /[A-Za-z]/.test(text) && !/[؀-ۿ]/.test(text) ? "en" : undefined;
}
