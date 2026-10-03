/**
 * Pure helpers for the raw-records view (`getDatasetRecordsPage` in
 * `queries.ts`): which column may be sorted, how the in-table search box is
 * sanitized, and the one regular expression that guards numeric casts in SQL.
 */

import { escapeLike } from "@/lib/search";

/** Rows per page of the records table. */
export const RECORDS_PAGE_SIZE = 25;

/** Longest in-table search text accepted (characters). */
export const MAX_RECORDS_QUERY_LENGTH = 60;

/** Longest column name accepted as a sort key before it is even compared with the schema. */
export const MAX_SORT_FIELD_LENGTH = 128;

/** Server-side budget for the sorted/filtered raw queries before they fall back or give up. */
export const RECORDS_STATEMENT_TIMEOUT_MS = 3000;

/**
 * Text that is safe to hand to `::numeric` in Postgres: optional sign,
 * digits with an optional fraction and an optional short exponent. The digit
 * and exponent bounds keep absurd values ("1e99999999") from overflowing the
 * cast and aborting the whole query.
 *
 * Deliberately written without a single backslash: `Prisma.sql` template
 * strings are *cooked*, so `\.` silently becomes `.` and the guard would
 * accept "1a2". `[.]` and `[0-9]` mean the same thing in every string
 * flavour. It is still passed as a bound parameter, never spliced into SQL.
 */
export const NUMERIC_TEXT_RE = "^-?[0-9]{1,30}([.][0-9]{1,30})?([eE][-+]?[0-9]{1,3})?$";

/** JS twin of `NUMERIC_TEXT_RE` (POSIX ARE and JS agree on this subset); used by tests and for documentation. */
export const NUMERIC_TEXT_JS = new RegExp(NUMERIC_TEXT_RE);

export interface FieldLike {
  name?: string | null;
  label?: string | null;
  type?: string | null;
}

/** ODS types whose values are objects/blobs: ordering by their JSON text is meaningless. */
const NON_SORTABLE_TYPES = new Set(["geo_point_2d", "geo_shape", "file", "json_blob"]);
const NUMERIC_TYPES = new Set(["int", "double"]);

export interface SortField {
  name: string;
  /** True for int/double columns: sorted by a guarded numeric cast with dirty values last. */
  numeric: boolean;
}

/**
 * Validate the requested sort column against the dataset's own schema. The
 * name is exact-matched (case-sensitive, as in the export JSON keys), capped
 * in length and must not be an object-valued column. Returns null for
 * anything else, which means "default order".
 */
export function resolveSortField(fields: readonly FieldLike[], requested: unknown): SortField | null {
  if (typeof requested !== "string") return null;
  const name = requested.trim();
  if (name === "" || name.length > MAX_SORT_FIELD_LENGTH) return null;
  const field = fields.find((f) => f.name === name);
  if (!field || !field.name) return null;
  const type = (field.type ?? "text").toLowerCase();
  if (NON_SORTABLE_TYPES.has(type)) return null;
  return { name: field.name, numeric: NUMERIC_TYPES.has(type) };
}

export interface RecordsSearch {
  /** The cleaned text to show back in the search box. */
  text: string;
  /** `%text%` with LIKE metacharacters escaped; matches literally with the default `\` escape. */
  pattern: string;
  /**
   * True when the text contains neither `"` nor `\`, the two characters JSON escapes. Then a cell
   * value containing the text always makes `data::text` contain it too, so `data::text ILIKE`
   * is a safe, cheap pre-filter in front of the exact per-value check.
   */
  jsonSafe: boolean;
}

/**
 * Sanitize the in-table search text: control characters removed, trimmed,
 * at most 60 characters, `\`, `%` and `_` escaped so "50%" or "_" match themselves instead of
 * acting as wildcards. Empty / non-string input means "no search" (null).
 */
export function normalizeRecordsQuery(raw: unknown): RecordsSearch | null {
  if (typeof raw !== "string") return null;
  const text = raw
    // A NUL byte makes Postgres reject the whole statement; other control characters are just noise.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, MAX_RECORDS_QUERY_LENGTH)
    .trim();
  if (text === "") return null;
  return { text, pattern: `%${escapeLike(text)}%`, jsonSafe: !/["\\]/.test(text) };
}
