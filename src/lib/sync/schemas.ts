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
 *    plus many more keys we don't use (title_ar, keyword, license, ...).
 *  - metas.default.theme IS an array of strings in every observed dataset
 *    (never null/absent in the 512 checked), but the spec calls out it may
 *    be empty/absent, so we keep it optional/nullable and take theme[0] as
 *    the primary display theme.
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
 * Every schema below uses .passthrough() and optional/nullable fields
 * liberally so an unexpected extra key or a genuinely missing field never
 * throws — a single dataset's schema surprises must never crash the sync.
 */

import { z } from "zod";

export const CatalogFieldSchema = z
  .object({
    name: z.string(),
    label: z.string().nullish(),
    // Observed: text | int | double | date | geo_point_2d. Any other
    // string is accepted here and treated as "text" by UI code later —
    // the spec explicitly says to treat unknown types as text rather than
    // reject them.
    type: z.string().nullish(),
    description: z.string().nullish(),
  })
  .passthrough();
export type CatalogField = z.infer<typeof CatalogFieldSchema>;

export const CatalogMetaDefaultSchema = z
  .object({
    title: z.string().nullish(),
    description: z.string().nullish(),
    // Observed live: always a non-empty string array. Kept optional/
    // nullable/loosely-typed per spec in case some dataset omits it.
    theme: z.array(z.string()).nullish(),
    publisher: z.string().nullish(),
    records_count: z.number().nullish(),
    modified: z.string().nullish(),
  })
  .passthrough();
export type CatalogMetaDefault = z.infer<typeof CatalogMetaDefaultSchema>;

export const CatalogMetasSchema = z
  .object({
    default: CatalogMetaDefaultSchema.optional(),
  })
  .passthrough();

export const CatalogDatasetSchema = z
  .object({
    dataset_id: z.string(),
    fields: z.array(CatalogFieldSchema).nullish().default([]),
    metas: CatalogMetasSchema.optional(),
  })
  .passthrough();
export type CatalogDataset = z.infer<typeof CatalogDatasetSchema>;

export const CatalogPageSchema = z
  .object({
    total_count: z.number(),
    results: z.array(CatalogDatasetSchema),
  })
  .passthrough();
export type CatalogPage = z.infer<typeof CatalogPageSchema>;

/** A single row from a dataset's /exports/json — shape varies per dataset. */
export const ExportRecordSchema = z.record(z.string(), z.unknown());
export type ExportRecord = z.infer<typeof ExportRecordSchema>;

export const ExportArraySchema = z.array(ExportRecordSchema);
