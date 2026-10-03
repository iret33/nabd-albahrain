/**
 * Mapping from one catalog entry to the Dataset metadata columns, and the
 * comparison used to skip rewriting rows whose metadata did not change.
 */

import { buildSearchText } from "@/lib/search";
import type { CatalogDataset, CatalogField } from "./schemas";
import { computeTitleClean, stableStringify } from "./utils";

const INT4_MAX = 2_147_483_647;

export interface DatasetMetadata {
  title: string;
  titleClean: string;
  description: string | null;
  theme: string | null;
  publisher: string | null;
  recordsCount: number;
  /** Null when the entry carried no `fields` at all: keep what is stored instead of wiping it. */
  fieldsJson: CatalogField[] | null;
  sourceModified: Date | null;
  titleAr: string | null;
  keywords: string[];
  license: string | null;
  /** normalizeSearch(title + titleClean + titleAr + publisher + theme + keywords + description). */
  searchText: string;
}

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Records count the catalog advertises for this entry (0 when absent/invalid). */
export function catalogRecordsCount(entry: CatalogDataset): number {
  const raw = entry.metas?.default?.records_count;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(INT4_MAX, Math.trunc(raw));
}

/** Derive the Dataset metadata columns from one catalog entry. */
export function metadataFromCatalogEntry(entry: CatalogDataset): DatasetMetadata {
  const meta = entry.metas?.default;
  const title = meta?.title?.trim() || entry.dataset_id;
  const titleClean = computeTitleClean(title);
  const theme = meta?.theme && meta.theme.length > 0 ? meta.theme[0] : null;
  const modified = meta?.modified ? new Date(meta.modified) : null;
  const description = meta?.description ?? null;
  const publisher = meta?.publisher ?? null;
  const titleAr = textOrNull(meta?.title_ar);
  const keywords = meta?.keyword ?? [];

  return {
    title,
    titleClean,
    description,
    theme,
    publisher,
    recordsCount: catalogRecordsCount(entry),
    fieldsJson: entry.fields ?? null,
    sourceModified: modified && !isNaN(modified.getTime()) ? modified : null,
    titleAr,
    keywords,
    license: textOrNull(meta?.license),
    // The raw title is included next to titleClean (when they differ) on
    // purpose: titleClean strips a leading number ("2021 Population Census"
    // -> "Population Census") and users do search by that year.
    searchText: buildSearchText([
      title !== titleClean ? title : null,
      titleClean,
      titleAr,
      publisher,
      theme,
      keywords,
      description,
    ]),
  };
}

/** The columns of an existing Dataset row that `metadataChanged` compares. */
export interface StoredMetadata {
  title: string;
  titleClean: string;
  description: string | null;
  theme: string | null;
  publisher: string | null;
  recordsCount: number;
  fieldsJson: unknown;
  sourceModified: Date | null;
  titleAr: string | null;
  keywords: string[];
  license: string | null;
  searchText: string;
}

/**
 * True when rewriting the row would change anything. `fieldsJson` is compared
 * with sorted keys on both sides because Postgres `jsonb` normalises key
 * order, so a naive stringify would report a change on every run.
 */
export function metadataChanged(next: DatasetMetadata, stored: StoredMetadata): boolean {
  return (
    next.title !== stored.title ||
    next.titleClean !== stored.titleClean ||
    next.description !== stored.description ||
    next.theme !== stored.theme ||
    next.publisher !== stored.publisher ||
    next.recordsCount !== stored.recordsCount ||
    (next.sourceModified?.getTime() ?? null) !== (stored.sourceModified?.getTime() ?? null) ||
    next.titleAr !== stored.titleAr ||
    next.license !== stored.license ||
    next.searchText !== stored.searchText ||
    next.keywords.length !== stored.keywords.length ||
    next.keywords.some((k, i) => k !== stored.keywords[i]) ||
    (next.fieldsJson !== null && stableStringify(next.fieldsJson) !== stableStringify(stored.fieldsJson))
  );
}
