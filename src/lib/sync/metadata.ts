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

/** A `modified` before the Unix epoch is portal noise, not a publication date. */
const MIN_MODIFIED_MS = 0;
/** Clock skew allowance: a `modified` further ahead than this is a bad value, not "just now". */
const MAX_MODIFIED_FUTURE_MS = 24 * 3_600_000;

/**
 * The catalog's `modified` as a Date, or null when it is unparseable or not
 * credible (before 1970, or more than a day ahead of `nowMs`). The value feeds
 * /updates, the Atom feed and the sitemap, where a single `9999-12-31` would
 * pin its dataset to the top of every list.
 *
 * Ignored, NOT clamped to "now": `metadataChanged` compares this column on
 * every run, so a clamped value would move each time and rewrite the row on
 * every sync, while null is stable until the portal fixes the value. A year
 * outside the range also never reaches Prisma (an extended-year string such as
 * "+010000-01-01T00:00:00Z" parses to a valid Date that createMany rejects,
 * which would abort the whole catalog phase).
 */
export function parseSourceModified(
  raw: string | null | undefined,
  nowMs: number = Date.now(),
): { date: Date | null; ignored: boolean } {
  if (!raw) return { date: null, ignored: false };
  const date = new Date(raw);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return { date: null, ignored: false };
  if (ms < MIN_MODIFIED_MS || ms > nowMs + MAX_MODIFIED_FUTURE_MS) return { date: null, ignored: true };
  return { date, ignored: false };
}

export interface MetadataOptions {
  /** Clock for the future-date bound (tests). */
  nowMs?: number;
  /** Called with the raw value when a `modified` was ignored as not credible. */
  onIgnoredModified?: (raw: string) => void;
}

/** Derive the Dataset metadata columns from one catalog entry. */
export function metadataFromCatalogEntry(entry: CatalogDataset, opts: MetadataOptions = {}): DatasetMetadata {
  const meta = entry.metas?.default;
  const title = meta?.title?.trim() || entry.dataset_id;
  const titleClean = computeTitleClean(title);
  const theme = meta?.theme && meta.theme.length > 0 ? meta.theme[0] : null;
  const modified = parseSourceModified(meta?.modified, opts.nowMs);
  if (modified.ignored && meta?.modified) opts.onIgnoredModified?.(meta.modified);
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
    sourceModified: modified.date,
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
