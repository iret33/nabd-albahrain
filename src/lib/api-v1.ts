/**
 * Shared plumbing of the public read-only JSON API (`/api/v1/*`): parameter
 * validation, response helpers and CSV encoding. Pure (no Prisma, no Next
 * runtime), so every rule is unit-tested; the route files stay thin.
 *
 * Contract highlights (documented for humans on /developers):
 *  - GET only, CORS open (`Access-Control-Allow-Origin: *`), JSON errors
 *    `{ error, message[, parameter] }` with 400 for a malformed parameter and
 *    404 for an unknown id/theme/publisher. Server faults are logged, never
 *    echoed: the body is a fixed `internal_error`.
 *  - Parameters are STRICT here, unlike the website (which quietly falls back
 *    to page 1): an API client that sends `limit=abc` wants to hear about it.
 *  - 200 responses carry `Cache-Control: public, s-maxage=300,
 *    stale-while-revalidate=3600`. This is the only place the site sends a
 *    public cache header; HTML pages stay uncacheable so a refresh shows up at
 *    once. Errors are `no-store`.
 *  - CSV cells that a spreadsheet could execute are neutralized (see `csvCell`).
 */

import { LIST_SORTS, MAX_QUERY_LENGTH, type ListParamsInput } from "@/lib/list-query";
import { isValidDatasetId, isValidPublisherSlug } from "@/lib/cache-config";
import { SITE_URL } from "@/lib/site";

export const API_LIST_DEFAULT_LIMIT = 30;
export const API_LIST_MAX_LIMIT = 100;
export const API_RECORDS_DEFAULT_LIMIT = 100;
export const API_RECORDS_MAX_LIMIT = 1000;
export const API_MAX_PAGE = 10_000;
/** Safety stop for a streamed CSV (the sync engine stores at most ~50,000 rows per dataset anyway). */
export const CSV_MAX_ROWS = 200_000;

export const CACHE_PUBLIC = "public, s-maxage=300, stale-while-revalidate=3600";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

// ---------------------------------------------------------------------------
// Errors and responses
// ---------------------------------------------------------------------------

/** A malformed request parameter; becomes a 400 with the parameter named. */
export class ApiParamError extends Error {
  constructor(
    public readonly parameter: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiParamError";
  }
}

export function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": CACHE_PUBLIC, ...CORS_HEADERS },
  });
}

export function jsonError(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

export const badRequest = (err: ApiParamError): Response =>
  jsonError(400, "invalid_parameter", err.message, { parameter: err.parameter });

export const notFound = (what: string): Response => jsonError(404, "not_found", `${what} not found`);

export const serverError = (): Response => jsonError(500, "internal_error", "Something went wrong. Please try again later.");

export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=86400" } });
}

/** CORS headers for a streamed (CSV) response built outside `jsonOk`. */
export const corsHeaders = (): Record<string, string> => ({ ...CORS_HEADERS });

// ---------------------------------------------------------------------------
// Parameter parsing
// ---------------------------------------------------------------------------

/** Strict integer in [min, max]; absent/empty -> `def`. Anything else (1.5, 1e3, -1, "abc", 99999999999) throws. */
export function parseIntParam(raw: string | null, name: string, opts: { min: number; max: number; def: number }): number {
  if (raw === null || raw.trim() === "") return opts.def;
  const text = raw.trim();
  if (!/^\d{1,9}$/.test(text)) throw new ApiParamError(name, `${name} must be an integer between ${opts.min} and ${opts.max}`);
  const n = Number.parseInt(text, 10);
  if (n < opts.min || n > opts.max) throw new ApiParamError(name, `${name} must be an integer between ${opts.min} and ${opts.max}`);
  return n;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * `updated_since`: `YYYY-MM-DD` (read as 00:00 UTC) or an ISO 8601 date-time
 * (no zone means UTC). Rejects impossible dates ("2026-02-31"): `Date`
 * would silently roll them over to March.
 */
export function parseUpdatedSince(raw: string | null): Date | null {
  if (raw === null || raw.trim() === "") return null;
  const text = raw.trim();
  const fail = () => new ApiParamError("updated_since", "updated_since must be an ISO 8601 date (2026-01-31) or date-time (2026-01-31T08:00:00Z)");
  if (!DATE_ONLY.test(text) && !DATE_TIME.test(text)) throw fail();

  const normalized = DATE_ONLY.test(text)
    ? `${text}T00:00:00Z`
    : /(Z|[+-]\d{2}:?\d{2})$/.test(text)
      ? text.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2") // "+0300" -> "+03:00" (what Date.parse requires)
      : `${text.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw fail();
  // Round-trip the calendar date to reject 02-31 style rollovers.
  const [y, m, d] = text.slice(0, 10).split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw fail();
  return date;
}

export interface DatasetsQuery {
  list: ListParamsInput;
  updatedSince: Date | null;
  limit: number;
}

/** Validate `GET /api/v1/datasets` params. Throws `ApiParamError`. */
export function parseDatasetsQuery(sp: URLSearchParams): DatasetsQuery {
  const q = (sp.get("q") ?? "").trim();
  if (q.length > MAX_QUERY_LENGTH) throw new ApiParamError("q", `q must be at most ${MAX_QUERY_LENGTH} characters`);

  const theme = (sp.get("theme") ?? "").trim();
  if (theme.length > 100) throw new ApiParamError("theme", "theme must be at most 100 characters");

  const publisher = (sp.get("publisher") ?? "").trim();
  if (publisher !== "" && !isValidPublisherSlug(publisher)) {
    throw new ApiParamError("publisher", "publisher must be a publisher slug (lowercase letters, digits and hyphens)");
  }

  const sortRaw = (sp.get("sort") ?? "").trim();
  if (sortRaw !== "" && !(LIST_SORTS as readonly string[]).includes(sortRaw)) {
    throw new ApiParamError("sort", `sort must be one of: ${LIST_SORTS.join(", ")}`);
  }

  const page = parseIntParam(sp.get("page"), "page", { min: 1, max: API_MAX_PAGE, def: 1 });
  const limit = parseIntParam(sp.get("limit"), "limit", { min: 1, max: API_LIST_MAX_LIMIT, def: API_LIST_DEFAULT_LIMIT });
  const updatedSince = parseUpdatedSince(sp.get("updated_since"));

  return {
    list: {
      q,
      theme: theme === "" ? null : theme,
      publisher: publisher === "" ? null : publisher,
      sort: sortRaw === "" ? null : sortRaw,
      page,
    },
    updatedSince,
    limit,
  };
}

export interface RecordsQuery {
  after: string | null;
  limit: number;
  format: "json" | "csv";
}

/** Validate `GET /api/v1/datasets/[id]/records` params. Throws `ApiParamError`. */
export function parseRecordsQuery(sp: URLSearchParams): RecordsQuery {
  const afterRaw = (sp.get("after") ?? "").trim();
  if (afterRaw !== "" && !/^\d{1,18}$/.test(afterRaw)) {
    throw new ApiParamError("after", "after must be a record id from a previous response (digits only)");
  }
  const formatRaw = (sp.get("format") ?? "json").trim().toLowerCase();
  if (formatRaw !== "json" && formatRaw !== "csv") throw new ApiParamError("format", "format must be json or csv");
  return {
    after: afterRaw === "" ? null : afterRaw,
    limit: parseIntParam(sp.get("limit"), "limit", { min: 1, max: API_RECORDS_MAX_LIMIT, def: API_RECORDS_DEFAULT_LIMIT }),
    format: formatRaw,
  };
}

/** A dataset id from the URL, decoded and structurally validated; null when it cannot name a dataset. */
export function parseDatasetId(raw: string): string | null {
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // keep the raw segment; the structural check below decides
  }
  return isValidDatasetId(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const iso = (d: Date | string | null | undefined): string | null => {
  if (d === null || d === undefined) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const datasetUrl = (id: string): string => `${SITE_URL}/dataset/${encodeURIComponent(id)}`;
export const officialDatasetUrl = (id: string): string => `https://www.data.gov.bh/explore/dataset/${encodeURIComponent(id)}/`;

export interface DatasetSummarySource {
  id: string;
  title: string;
  titleAr: string | null;
  theme: string | null;
  publisher: string | null;
  recordsCount: number;
  sourceModified: Date | string | null;
  lastSyncedAt: Date | string | null;
}

/** One row of `GET /api/v1/datasets`. `title` is the portal's own title, unmodified. */
export function toDatasetSummary(d: DatasetSummarySource) {
  return {
    id: d.id,
    title: d.title,
    titleAr: d.titleAr?.trim() ? d.titleAr : null,
    theme: d.theme,
    publisher: d.publisher,
    recordsCount: d.recordsCount,
    sourceModified: iso(d.sourceModified),
    lastSyncedAt: iso(d.lastSyncedAt),
    url: datasetUrl(d.id),
    officialUrl: officialDatasetUrl(d.id),
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const CSV_BOM = "\uFEFF";

/** Text a spreadsheet reads as a plain number: safe even though it starts with "-". */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * One CSV cell.
 *
 * Spreadsheet formula injection: Excel, LibreOffice and Sheets execute a cell
 * whose text starts with `=`, `+`, `-`, `@` (or a tab/CR that is stripped
 * before the check). Dataset values are third-party text, so such a cell gets a
 * leading `'` (the spreadsheet then shows the text literally). JS numbers and
 * plain numeric text ("-5", "3.2e4") are exempt: they are data, not formulas,
 * and prefixing them would turn every negative number into text.
 *
 * Then RFC 4180: a cell containing a comma, quote or line break is quoted with
 * its quotes doubled. Objects/arrays (geo points, lists) become JSON.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "number" || typeof value === "bigint") {
    text = String(value);
  } else if (typeof value === "boolean") {
    text = value ? "true" : "false";
  } else if (typeof value === "string") {
    text = value;
    if (/^[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  } else {
    text = JSON.stringify(value) ?? "";
    if (/^[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV record (CRLF-terminated). */
export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/** `Content-Disposition` for a download named after the dataset, safe for any id (ASCII fallback + RFC 5987 name). */
export function csvContentDisposition(datasetId: string): string {
  const ascii = datasetId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100) || "dataset";
  return `attachment; filename="${ascii}.csv"; filename*=UTF-8''${encodeURIComponent(datasetId).slice(0, 300)}.csv`;
}
