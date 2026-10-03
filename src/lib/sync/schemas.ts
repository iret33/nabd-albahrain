/**
 * Zod schemas for the data.gov.bh (OpenDataSoft Explore API v2.1) responses.
 *
 * Verified against the live API on 2026-08-04 (Phase 2 reality check, see
 * PR/commit message for the raw responses inspected):
 *
 *  - GET /catalog/datasets?limit=100&offset=0 returns { total_count, results[] }.
 *    total_count was 512 at check time.
 *  - Each result has: dataset_id, fields[] (name/label/type + extra keys),
 *    metas.default with title/description/theme/publisher/records_count/modified
 *    plus many more keys (title_ar, keyword, license, ...).
 *  - metas.default.theme IS an array of strings in every observed dataset
 *    (never null/absent in the 512 checked), but the spec calls out it may be
 *    empty/absent, so we keep it optional/nullable and take theme[0] as the
 *    primary display theme.
 *  - metas.default.publisher was present on every observed dataset, but the
 *    spec calls out it may be absent, so it's optional/nullable too.
 *  - Field types observed across all 512 datasets: text, int, double, date,
 *    geo_point_2d. datetime/boolean/geo_shape/file were NOT observed live,
 *    but the schema still accepts any string type (unknown types are
 *    treated as "text" by downstream consumers, per spec).
 *  - GET /catalog/datasets/{id}/exports/json returns a flat JSON array of
 *    plain objects — keys vary per dataset, values can be string, number,
 *    null, or (for geo fields) nested objects. No pagination envelope.
 *
 * UNVERIFIED (the portal is not reachable from the development sandbox): the
 * exact names/shapes of `data_processed`, `metadata_processed`, `title_ar`,
 * `keyword`, `license` and `language` in `metas.default`. They are modelled
 * as optional and tolerant, and every consumer degrades gracefully when one
 * is absent (change detection falls back to modified + records_count).
 *
 * Robustness contract (the previous schema promised this but a single odd
 * entry rejected the whole 100-dataset page): the page envelope only demands
 * `total_count` and `results`; every ENTRY is validated on its own
 * (`parseCatalogEntry`) so one malformed dataset is skipped and reported
 * instead of aborting the sync. Cosmetic leaves (titles, license, keywords,
 * unknown field attributes) tolerate surprises; the leaves change detection
 * relies on (`records_count`, `modified`) must be well-formed or the entry is
 * skipped, because guessing there would silently break freshness.
 */

import { z } from "zod";

/** Numeric strings ("12") are accepted; "", "n/a", NaN and objects are not. */
const numeric = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v),
  z.number().finite(),
);

/** Text we only display/search: anything that is not a string becomes null. */
const looseText = z.string().nullish().catch(null);

/** A change-detection token that may arrive as a string or a number. */
const looseToken = z.union([z.string(), z.number()]).nullish().catch(null);

function cleanList(items: unknown[], maxItems: number, maxLen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, maxLen);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** `theme`: a string array in practice; a bare string becomes a one-item list. */
const themeList = z
  .union([z.array(z.unknown()), z.string()])
  .transform((v) => cleanList(Array.isArray(v) ? v : [v], 10, 200))
  .nullish()
  .catch(null);

/** `keyword`: a string array, or one string with comma / semicolon / Arabic-comma separators. */
const keywordList = z
  .union([z.array(z.unknown()), z.string()])
  .transform((v) => cleanList(Array.isArray(v) ? v : v.split(/[,;،]/), 30, 80))
  .nullish()
  .catch(null);

export const CatalogFieldSchema = z
  .object({
    name: z.string(),
    label: looseText,
    // Observed: text | int | double | date | geo_point_2d. Any other
    // string is accepted here and treated as "text" by UI code later —
    // the spec explicitly says to treat unknown types as text rather than
    // reject them.
    type: looseText,
    description: looseText,
  })
  .passthrough();
export type CatalogField = z.infer<typeof CatalogFieldSchema>;

/**
 * `fields[]`: undefined when the entry has none (so callers can tell "absent"
 * from "empty"), otherwise only the well-formed fields — one field without a
 * `name` must not cost the whole dataset.
 */
const fieldList = z
  .array(z.unknown())
  .nullish()
  .transform((items): CatalogField[] | undefined =>
    items == null
      ? undefined
      : items.flatMap((item) => {
          const parsed = CatalogFieldSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        }),
  );

export const CatalogMetaDefaultSchema = z
  .object({
    title: looseText,
    description: looseText,
    theme: themeList,
    publisher: looseText,
    records_count: numeric.nullish(),
    modified: z.string().nullish(),
    // --- Change detection (see version.ts) ---
    data_processed: looseToken,
    metadata_processed: looseToken,
    // --- Discovery metadata persisted onto Dataset ---
    title_ar: looseText,
    keyword: keywordList,
    license: looseText,
    language: looseText,
  })
  .passthrough();
export type CatalogMetaDefault = z.infer<typeof CatalogMetaDefaultSchema>;

export const CatalogMetasSchema = z
  .object({
    default: CatalogMetaDefaultSchema.nullish(),
  })
  .passthrough();

export const CatalogDatasetSchema = z
  .object({
    dataset_id: z.string().min(1).max(300),
    fields: fieldList,
    metas: CatalogMetasSchema.nullish(),
  })
  .passthrough();
export type CatalogDataset = z.infer<typeof CatalogDatasetSchema>;

/**
 * Lenient page envelope: only `total_count` and `results` are mandatory, and
 * `results` entries stay `unknown` here — each one is validated separately
 * with `parseCatalogEntry`.
 */
export const CatalogPageSchema = z
  .object({
    total_count: numeric,
    results: z.array(z.unknown()),
  })
  .passthrough();
export type CatalogPage = z.infer<typeof CatalogPageSchema>;

export type CatalogEntryParse =
  | { ok: true; datasetId: string; entry: CatalogDataset }
  | { ok: false; datasetId: string | null; issue: string };

/**
 * Validate one raw catalog entry. A failure carries the dataset id (when it
 * could be read at all) and a short, path-qualified reason such as
 * `metas.default.records_count: Expected number, received string`.
 */
export function parseCatalogEntry(raw: unknown): CatalogEntryParse {
  const parsed = CatalogDatasetSchema.safeParse(raw);
  if (parsed.success) return { ok: true, datasetId: parsed.data.dataset_id, entry: parsed.data };

  const rawId =
    raw && typeof raw === "object" && typeof (raw as { dataset_id?: unknown }).dataset_id === "string"
      ? (raw as { dataset_id: string }).dataset_id.slice(0, 300)
      : null;
  const first = parsed.error.issues[0];
  const issue = first ? `${first.path.join(".") || "(entry)"}: ${first.message}` : "invalid entry";
  return { ok: false, datasetId: rawId || null, issue };
}

/** A single row from a dataset's /exports/json — shape varies per dataset. */
export const ExportRecordSchema = z.record(z.string(), z.unknown());
export type ExportRecord = z.infer<typeof ExportRecordSchema>;

export const ExportArraySchema = z.array(ExportRecordSchema);
