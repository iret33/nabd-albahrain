/**
 * The sync engine: fetches the full data.gov.bh catalog, upserts dataset
 * metadata, flags datasets that disappeared upstream, then re-downloads and
 * re-derives ONLY the datasets whose source version changed (everything with
 * --force). See the module-level comments in each imported file for the
 * specifics of each step.
 *
 * Callable directly via runSync(opts) (CLI, scheduler), or through
 * startSyncInBackground(opts) (API routes), which takes the lock BEFORE
 * returning so callers can answer 202 vs 409 truthfully.
 *
 * Safety properties, in short:
 *  - one run at a time (atomic lock with heartbeat, lock.ts);
 *  - a run is only recorded as it happens: the SyncLog row exists from the
 *    moment the lock is held and is finalized in `finally`, so failures and
 *    crashes are visible (log.ts, run.ts);
 *  - nothing is pruned or overwritten from a partial picture: an incomplete
 *    catalog throws before any write, an empty/truncated export leaves the
 *    stored rows untouched, and removal needs a complete, plausible catalog;
 *  - "unchanged" means "the portal's version token equals the one we synced
 *    from", never a comparison of our clock with the portal's.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncConfig } from "./config";
import { computeDerivedFields, DERIVED_VERSION } from "./derived";
import { SyncAbortedError, SyncIntegrityError, describeError } from "./errors";
import { SyncAlreadyRunningError, type SyncLockHandle } from "./lock";
import {
  emptyChangedSets,
  type ChangedSets,
  type RunCounters,
  type RunFailure,
  type SyncStatePatch,
} from "./log";
import { assertExportIntegrity, assertPlausibleCatalog, isBigDataset } from "./integrity";
import {
  catalogRecordsCount,
  metadataChanged,
  metadataFromCatalogEntry,
} from "./metadata";
import {
  fetchCatalogEntry,
  fetchDatasetExport,
  fetchFullCatalog,
  type CatalogSkip,
} from "./ods-client";
import {
  beginRun,
  createProgressWriter,
  endRun,
  statusFromError,
  type RunContext,
} from "./run";
import type { CatalogDataset, CatalogField } from "./schemas";
import { chunk, createGate, mapWithConcurrency } from "./utils";
import { computeSourceVersion } from "./version";
import { INSERT_BATCH_SIZE, MAX_ROWS_HARD_CAP, MAX_ROWS_STORED_WHEN_CAPPED } from "@/lib/row-limits";


export interface RunSyncOptions {
  /** Only sync records for the first N datasets (catalog order). */
  limit?: number;
  /** Only sync records for this one dataset_id. */
  datasetId?: string;
  /** Re-fetch records even if the source version is unchanged. */
  force?: boolean;
  /** Recorded on the SyncLog row: "cli" | "api" | "auto" | "public" | etc. */
  trigger: string;
  /**
   * Do not download datasets whose catalog records_count exceeds this; they
   * are reported as deferred (SyncLog.changedJson.deferred) for a later run.
   */
  maxRecords?: number;
  /** Re-download at most this many changed datasets (smallest first); the rest are deferred. */
  maxDatasets?: number;
  /**
   * Catalog pass + change detection only: returns what WOULD change, writes
   * nothing (no lock, no SyncLog row, no metadata upsert) and downloads
   * nothing. `syncLogId` is 0.
   */
  dryRun?: boolean;
  /** A lock the caller already acquired; the run takes ownership and releases it. */
  lock?: SyncLockHandle;
  /** Cooperative cancellation (e.g. the CLI's SIGTERM handler). */
  signal?: AbortSignal;
}

export interface RunSyncResult {
  /** Datasets decided on this run (skipped + deferred + updated + failed, incl. malformed catalog entries). */
  processed: number;
  /** Datasets that ended fine, INCLUDING skipped (unchanged) ones. */
  succeeded: number;
  failed: number;
  /** Unchanged datasets that were left alone. */
  skipped: number;
  failures: Array<{ datasetId: string; error: string }>;
  /** SyncLog row id (0 for dry runs). */
  syncLogId: number;
  /** Datasets whose records were re-downloaded and re-derived (dry run: that WOULD be). */
  updated: number;
  /** Changed datasets left for a later run (maxRecords / maxDatasets). */
  deferred: number;
  /** Datasets flagged removed upstream (dry run: that would be). */
  removed: number;
  /** Datasets seen for the first time. */
  added: number;
  /** The ids behind updated / deferred / removed / added. */
  changed: ChangedSets;
  /**
   * Whole-run failures are RETURNED here (and on the SyncLog row), not
   * thrown. Only SyncAlreadyRunningError and failures to even start (lock /
   * log row) throw.
   */
  status: "success" | "partial" | "failed" | "aborted";
  /** Sanitized top-level message when status is failed/aborted (or a summary for partial). */
  error?: string;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Stored state used for change detection and metadata diffs
// ---------------------------------------------------------------------------

const STORED_SELECT = {
  id: true,
  title: true,
  titleClean: true,
  description: true,
  theme: true,
  publisher: true,
  recordsCount: true,
  fieldsJson: true,
  sourceModified: true,
  titleAr: true,
  keywords: true,
  license: true,
  searchText: true,
  removedAt: true,
  syncStatus: true,
  syncedVersion: true,
  sourceCount: true,
} satisfies Prisma.DatasetSelect;

type StoredDataset = Prisma.DatasetGetPayload<{ select: typeof STORED_SELECT }>;

function describeScope(opts: RunSyncOptions): string {
  if (opts.datasetId) return `dataset:${opts.datasetId}`;
  return opts.force ? "all" : "changed";
}

/** Why this dataset must be re-downloaded, or null when it can be skipped. */
export function changeReason(
  entry: CatalogDataset,
  stored: Pick<StoredDataset, "syncStatus" | "syncedVersion" | "sourceCount"> | undefined,
  force: boolean,
): "forced" | "new" | "not-ok" | "version" | "inconsistent" | null {
  if (force) return "forced";
  if (!stored) return "new";
  // A dataset left in "error" (or never synced) must always be retried, even
  // when its version token happens to match.
  if (stored.syncStatus !== "ok" && stored.syncStatus !== "partial") return "not-ok";
  // Legacy rows (syncedVersion null) count as changed exactly once.
  if (stored.syncedVersion !== computeSourceVersion(entry)) return "version";
  // The catalog advertises rows but we hold none: the stored copy is unusable.
  if (stored.sourceCount === 0 && catalogRecordsCount(entry) > 0) return "inconsistent";
  return null;
}

interface Plan {
  /** Unchanged: nothing to do. */
  skipped: CatalogDataset[];
  /** To download this run, smallest first. */
  download: CatalogDataset[];
  /** Changed but left for a later run. */
  deferred: CatalogDataset[];
}

function planChanges(
  scope: CatalogDataset[],
  stored: Map<string, StoredDataset>,
  opts: Pick<RunSyncOptions, "force" | "maxRecords" | "maxDatasets">,
): Plan {
  const skipped: CatalogDataset[] = [];
  const changed: CatalogDataset[] = [];
  for (const entry of scope) {
    if (changeReason(entry, stored.get(entry.dataset_id), Boolean(opts.force)) === null) skipped.push(entry);
    else changed.push(entry);
  }

  const deferred: CatalogDataset[] = [];
  let download: CatalogDataset[] = [];
  for (const entry of changed) {
    if (opts.maxRecords !== undefined && catalogRecordsCount(entry) > opts.maxRecords) deferred.push(entry);
    else download.push(entry);
  }

  // Cheapest first, so a capped run (public refresh) delivers the most
  // updates; the big ones wait for the scheduled/admin run.
  download.sort(
    (a, b) => catalogRecordsCount(a) - catalogRecordsCount(b) || a.dataset_id.localeCompare(b.dataset_id),
  );
  if (opts.maxDatasets !== undefined && opts.maxDatasets >= 0 && download.length > opts.maxDatasets) {
    deferred.push(...download.slice(opts.maxDatasets));
    download = download.slice(0, opts.maxDatasets);
  }
  return { skipped, download, deferred };
}

// ---------------------------------------------------------------------------
// Catalog step
// ---------------------------------------------------------------------------

/**
 * Step (b): create new datasets and refresh the metadata of existing ones,
 * touching only rows whose metadata actually changed (and clearing
 * `removedAt` on ids that reappeared). Never touches sync-state columns.
 *
 * Returns the ids that were `created` and the ids of existing rows that were
 * `rewritten` (a metadata-only change such as a new title, or a reappeared
 * dataset). The two are kept apart on purpose: `created` is what the run
 * reports as "new datasets", while `rewritten` only widens the cache
 * invalidation (the per-dataset caches live 30 minutes and carry the title,
 * description and licence).
 */
async function upsertCatalogMetadata(
  entries: CatalogDataset[],
  stored: Map<string, StoredDataset>,
): Promise<{ created: string[]; rewritten: string[] }> {
  const creates: Array<{ id: string; meta: ReturnType<typeof metadataFromCatalogEntry> }> = [];
  const updates: Array<{ id: string; meta: ReturnType<typeof metadataFromCatalogEntry> }> = [];

  for (const entry of entries) {
    const meta = metadataFromCatalogEntry(entry, {
      onIgnoredModified: (raw) =>
        console.warn(
          `[sync] ${entry.dataset_id}: ignoring the portal's modified date ${JSON.stringify(raw.slice(0, 40))} ` +
            `(not a credible publication date); it will not be used for ordering or freshness.`,
        ),
    });
    const existing = stored.get(entry.dataset_id);
    if (!existing) creates.push({ id: entry.dataset_id, meta });
    else if (existing.removedAt !== null || metadataChanged(meta, existing)) {
      updates.push({ id: entry.dataset_id, meta });
    }
  }

  for (const batch of chunk(creates, 100)) {
    await prisma.dataset.createMany({
      data: batch.map(({ id, meta }) => ({
        id,
        ...meta,
        fieldsJson: (meta.fieldsJson ?? []) as unknown as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  }

  await mapWithConcurrency(
    chunk(updates, 25),
    4,
    (batch) =>
      prisma.$transaction(
        batch.map(({ id, meta }) =>
          prisma.dataset.update({
            where: { id },
            data: {
              ...meta,
              // Absent `fields` in the entry means "keep what we have".
              fieldsJson:
                meta.fieldsJson === null ? undefined : (meta.fieldsJson as unknown as Prisma.InputJsonValue),
              removedAt: null,
            },
          }),
        ),
      ),
    (_batch, _index, err) => {
      throw err;
    },
  );

  return { created: creates.map((c) => c.id), rewritten: updates.map((u) => u.id) };
}

/** Record that these datasets were consulted in a catalog pass (one UPDATE per 5000 ids). */
async function markChecked(ids: Iterable<string>, at: Date): Promise<void> {
  for (const batch of chunk([...ids], 5000)) {
    await prisma.dataset.updateMany({ where: { id: { in: batch } }, data: { lastCheckedAt: at } });
  }
}

async function flagRemoved(ids: string[], at: Date): Promise<string[]> {
  if (ids.length === 0) return [];
  const flagged: string[] = [];
  for (const batch of chunk(ids, 5000)) {
    // Ids are read first so the report lists exactly the rows that changed.
    const live = await prisma.dataset.findMany({
      where: { id: { in: batch }, removedAt: null },
      select: { id: true },
    });
    if (live.length === 0) continue;
    await prisma.dataset.updateMany({
      where: { id: { in: live.map((r) => r.id) }, removedAt: null },
      data: { removedAt: at },
    });
    flagged.push(...live.map((r) => r.id));
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// Per-dataset step
// ---------------------------------------------------------------------------

type DatasetOutcome =
  | { status: "ok" | "partial" }
  | { status: "error"; error: string }
  | { status: "aborted" };

/** Steps (c)-(f) for one dataset. Never throws — errors are returned as a result. */
async function syncOneDataset(
  entry: CatalogDataset,
  stored: StoredDataset | undefined,
  force: boolean,
  signal: AbortSignal,
): Promise<DatasetOutcome> {
  const datasetId = entry.dataset_id;
  // Captured from the entry this run started from (NOT re-read after the
  // download): if the portal changes while we download, the next catalog
  // pass sees a different token and syncs again.
  const version = computeSourceVersion(entry);
  const freshCount = catalogRecordsCount(entry);

  try {
    const records = await fetchDatasetExport(datasetId, { signal });
    assertExportIntegrity(records.length, freshCount, stored, force);

    const partial = records.length > MAX_ROWS_HARD_CAP;
    const toStore = partial ? records.slice(0, MAX_ROWS_STORED_WHEN_CAPPED) : records;

    // Derived fields are computed over the FULL fetched array (not just
    // `toStore`) so stats stay accurate even when storage was capped by the
    // size guard. The field schema is the one of the entry we just fetched
    // (falling back to the stored one if the entry carried none).
    const fields = (entry.fields ?? (stored?.fieldsJson as unknown as CatalogField[] | undefined) ?? []) as CatalogField[];
    const derived = await computeDerivedFields(datasetId, records, fields);

    await prisma.$transaction(
      async (tx) => {
        // Serialize concurrent replacements of the same dataset (defense in
        // depth behind the sync lock): the second transaction's DELETE then
        // starts after the first commit and sees its rows.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${datasetId}))`;
        await tx.datasetRecord.deleteMany({ where: { datasetId } });
        for (const batch of chunk(toStore, INSERT_BATCH_SIZE)) {
          await tx.datasetRecord.createMany({
            data: batch.map((row) => ({ datasetId, data: row as Prisma.InputJsonValue })),
          });
        }
        // Same transaction as the rows: the Dataset row never describes
        // records that were not committed with it.
        await tx.dataset.update({
          where: { id: datasetId },
          data: {
            sourceCount: toStore.length,
            syncStatus: partial ? "partial" : "ok",
            syncError: null,
            lastSyncedAt: new Date(),
            syncedVersion: version,
            derivedVersion: DERIVED_VERSION,
            // Prisma.DbNull writes an actual SQL NULL; Prisma.JsonNull would
            // store the JSON literal `null`, which reads back as "computed,
            // and the answer is null".
            statsJson: (derived.statsJson ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
            vizConfig: (derived.vizConfig ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
            chartData: (derived.chartData ?? Prisma.DbNull) as Prisma.InputJsonValue,
            summaryAr: derived.summaryAr,
          },
        });
      },
      { timeout: 120_000, maxWait: 30_000 },
    );

    return { status: partial ? "partial" : "ok" };
  } catch (err) {
    if (err instanceof SyncAbortedError || signal.aborted) return { status: "aborted" };

    // Full detail stays in the server log; the database (and so the admin UI
    // and /api/sync/status) only gets the sanitized, classified message.
    console.error(`[sync] ${datasetId} failed:`, err);
    const described = describeError(err);
    // Best-effort: record the failure on the Dataset row too, but don't let
    // a failure here (e.g. DB hiccup) mask the original error.
    await prisma.dataset
      .update({ where: { id: datasetId }, data: { syncStatus: "error", syncError: described.message } })
      .catch((updateErr) => console.error(`[sync] Could not record the error for ${datasetId}:`, updateErr));
    return { status: "error", error: described.message };
  }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

interface RunState {
  counters: RunCounters;
  failures: RunFailure[];
  changed: ChangedSets;
  /** When a complete catalog pass finished and was applied (null = none did). */
  catalogCheckedAt: Date | null;
  /**
   * Dataset ids whose cached pages must be dropped although nothing is
   * reported as changed for them: rows rewritten for a metadata-only change,
   * reappeared datasets, and the one dataset a single-dataset run checked
   * (its "last checked" moved). Kept apart from `changed` because that feeds
   * the run counters, the SyncLog JSON, the /updates feed and the CLI summary.
   */
  notifyExtra: Set<string>;
}

function newRunState(): RunState {
  return {
    counters: { total: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, updated: 0 },
    failures: [],
    changed: emptyChangedSets(),
    catalogCheckedAt: null,
    notifyExtra: new Set(),
  };
}

/**
 * Does this run look at the WHOLE catalog without caps? Only such a run may
 * advance the scheduler's clock (SyncState.lastFullPassAt): a public press
 * defers the big datasets, so letting it postpone the scheduled pass would
 * starve exactly the datasets the schedule exists for.
 */
export function isUnrestrictedCatalogRun(
  opts: Pick<RunSyncOptions, "datasetId" | "maxRecords" | "maxDatasets" | "limit" | "dryRun">,
): boolean {
  return (
    !opts.datasetId &&
    !opts.dryRun &&
    opts.maxRecords === undefined &&
    opts.maxDatasets === undefined &&
    !(opts.limit && opts.limit > 0)
  );
}

function recordMalformed(st: RunState, skipped: CatalogSkip[]): void {
  for (const s of skipped) {
    st.failures.push({ datasetId: s.datasetId, error: `Catalog entry skipped as malformed: ${s.issue}` });
    console.error(`[sync]   MALFORMED catalog entry ${s.datasetId}: ${s.issue}`);
  }
  st.counters.failed += skipped.length;
  st.counters.processed += skipped.length;
  st.counters.total += skipped.length;
}

async function loadStored(datasetId: string | undefined): Promise<Map<string, StoredDataset>> {
  const rows = datasetId
    ? await prisma.dataset.findMany({ where: { id: datasetId }, select: STORED_SELECT })
    : await prisma.dataset.findMany({ select: STORED_SELECT });
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Catalog phase shared by real and dry runs. Returns the entries in scope.
 * With `write: false` nothing is persisted (dry run), but the same guards
 * apply and removals/additions are still computed and reported.
 */
async function catalogPhase(
  opts: RunSyncOptions,
  st: RunState,
  signal: AbortSignal,
  write: boolean,
): Promise<{ scope: CatalogDataset[]; stored: Map<string, StoredDataset> }> {
  const now = new Date();

  if (opts.datasetId) {
    // Whatever happens next (also a failure), this dataset's cached pages are
    // stale: its "last checked" moves, and a removal/metadata change may land.
    st.notifyExtra.add(opts.datasetId);
    console.log(`[sync] Fetching catalog entry for ${opts.datasetId}...`);
    const result = await fetchCatalogEntry(opts.datasetId, { signal });
    const stored = await loadStored(opts.datasetId);

    if (!result.entry) {
      if (result.malformedIssue) {
        throw new SyncIntegrityError(
          `Dataset ${opts.datasetId} has a malformed catalog entry on the portal (${result.malformedIssue})`,
        );
      }
      // Came from a complete catalog: the portal does not list it. The same
      // plausibility guard as the catalog-wide path applies, against the live
      // count of the WHOLE database (`stored` holds only this one row): a
      // portal glitch serving an empty or truncated catalog must not let one
      // anonymous press hide a dataset. Before any write, so dry runs refuse too.
      if (result.catalogSeenCount !== undefined) {
        assertPlausibleCatalog(result.catalogSeenCount, await prisma.dataset.count({ where: { removedAt: null } }));
      }
      if (write) st.changed.removed.push(...(await flagRemoved([opts.datasetId], now)));
      else if (stored.get(opts.datasetId)?.removedAt === null) st.changed.removed.push(opts.datasetId);
      throw new SyncIntegrityError(`Dataset ${opts.datasetId} is no longer listed in the portal catalog`);
    }

    if (write) {
      const { created, rewritten } = await upsertCatalogMetadata([result.entry], stored);
      st.changed.added.push(...created);
      for (const id of rewritten) st.notifyExtra.add(id);
      await markChecked([opts.datasetId], now);
    } else if (!stored.has(opts.datasetId)) {
      st.changed.added.push(opts.datasetId);
    }
    return { scope: [result.entry], stored };
  }

  console.log("[sync] Fetching full catalog...");
  const catalog = await fetchFullCatalog({ signal });
  console.log(
    `[sync] Catalog fetched: ${catalog.datasets.length} datasets` +
      (catalog.skipped.length > 0 ? ` (+${catalog.skipped.length} malformed entries skipped)` : "") +
      ".",
  );
  recordMalformed(st, catalog.skipped);

  const stored = await loadStored(undefined);
  const knownLive = [...stored.values()].filter((r) => r.removedAt === null);
  assertPlausibleCatalog(catalog.seenIds.size, knownLive.length);

  // Datasets in the DB that a COMPLETE, plausible catalog no longer lists.
  const absent = knownLive.map((r) => r.id).filter((id) => !catalog.seenIds.has(id));

  if (write) {
    console.log("[sync] Upserting dataset metadata...");
    const { created, rewritten } = await upsertCatalogMetadata(catalog.datasets, stored);
    st.changed.added.push(...created);
    for (const id of rewritten) st.notifyExtra.add(id);
    st.changed.removed.push(...(await flagRemoved(absent, now)));
    await markChecked(catalog.seenIds, now);
    st.catalogCheckedAt = now;
  } else {
    st.changed.added.push(...catalog.datasets.map((d) => d.dataset_id).filter((id) => !stored.has(id)));
    st.changed.removed.push(...absent);
  }

  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : undefined;
  return { scope: limit ? catalog.datasets.slice(0, limit) : catalog.datasets, stored };
}

async function runPipeline(ctx: RunContext, opts: RunSyncOptions, st: RunState): Promise<void> {
  const signal = ctx.abort.signal;
  const { scope, stored } = await catalogPhase(opts, st, signal, true);
  const plan = planChanges(scope, stored, opts);

  st.counters.total += scope.length;
  st.counters.skipped = plan.skipped.length;
  st.counters.succeeded = plan.skipped.length;
  st.counters.processed += plan.skipped.length + plan.deferred.length;
  st.changed.deferred.push(...plan.deferred.map((d) => d.dataset_id));

  console.log(
    `[sync] ${scope.length} dataset(s) in scope: ${plan.download.length} to download, ` +
      `${plan.skipped.length} unchanged, ${plan.deferred.length} deferred ` +
      `(concurrency ${syncConfig.concurrency}${opts.force ? ", forced" : ""}).`,
  );

  const progress = createProgressWriter(ctx.logId, st.counters);
  await progress.flush();

  // Big datasets go one at a time across the WHOLE step (download, derive and
  // the pinned-connection transaction), not just around the transaction: a
  // downloaded 300k-row array that merely waits for a slot would keep its
  // memory. The wait is abortable and holds no HTTP limiter slot (that lives
  // inside the fetch). Smallest-first ordering already puts them at the tail.
  const bigGate = createGate(1);
  const sync = (entry: CatalogDataset): Promise<DatasetOutcome> => {
    const run = () => syncOneDataset(entry, stored.get(entry.dataset_id), Boolean(opts.force), signal);
    if (!isBigDataset(entry)) return run();
    return bigGate.run(run, signal).catch((err): DatasetOutcome => {
      if (signal.aborted) return { status: "aborted" };
      throw err;
    });
  };

  await mapWithConcurrency(
    plan.download,
    syncConfig.concurrency,
    async (entry) => {
      const outcome = await sync(entry);
      if (outcome.status === "aborted") return outcome;
      st.counters.processed++;
      if (outcome.status === "error") {
        st.counters.failed++;
        st.failures.push({ datasetId: entry.dataset_id, error: outcome.error });
        console.error(`[sync]   FAILED ${entry.dataset_id}: ${outcome.error}`);
      } else {
        st.counters.succeeded++;
        st.counters.updated++;
        st.changed.updated.push(entry.dataset_id);
        console.log(`[sync]   ${outcome.status === "partial" ? "partial" : "ok"}     ${entry.dataset_id}`);
      }
      progress.tick();
      return outcome;
    },
    (entry, _index, err) => {
      // A worker should never throw (syncOneDataset catches internally),
      // but stay defensive in case something outside it does.
      console.error(`[sync] ${entry.dataset_id} failed unexpectedly:`, err);
      const message = describeError(err).message;
      st.counters.processed++;
      st.counters.failed++;
      st.failures.push({ datasetId: entry.dataset_id, error: message });
      return { status: "error", error: message } as DatasetOutcome;
    },
    () => signal.aborted,
  );

  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new SyncAbortedError();
  }
}

function toResult(st: RunState, finalStatus: RunSyncResult["status"], error: string | null, syncLogId: number): RunSyncResult {
  const c = st.counters;
  return {
    processed: c.processed,
    succeeded: c.succeeded,
    failed: c.failed,
    skipped: c.skipped,
    failures: st.failures,
    syncLogId,
    updated: c.updated,
    deferred: st.changed.deferred.length,
    removed: st.changed.removed.length,
    added: st.changed.added.length,
    changed: st.changed,
    status: finalStatus,
    ...(error ? { error } : {}),
  };
}

/** Run everything after the lock/log row exist. Never throws. */
async function executeRun(ctx: RunContext, opts: RunSyncOptions): Promise<RunSyncResult> {
  const st = newRunState();
  let status: RunSyncResult["status"] = "success";
  let error: string | null = null;

  try {
    await runPipeline(ctx, opts, st);
  } catch (err) {
    const described = statusFromError(err, ctx.abort.signal);
    status = described.status;
    error = described.error;
  }

  if (status === "success" && st.counters.failed > 0) {
    status = st.counters.succeeded > 0 ? "partial" : "failed";
    const first = st.failures[0];
    error =
      st.failures.length === 1 && first
        ? first.error
        : `${st.failures.length} dataset(s) failed${first ? ` (e.g. ${first.datasetId}: ${first.error})` : ""}`;
  }

  const now = new Date();
  const statePatch: SyncStatePatch = {};
  // The moment the catalog pass was applied, not the end of a possibly long run.
  if (st.catalogCheckedAt) {
    statePatch.lastCatalogCheckAt = st.catalogCheckedAt;
    // The scheduler's due-clock moves only for an UNRESTRICTED pass, and (like
    // lastCatalogCheckAt) as soon as the catalog was applied, whatever happened
    // to individual datasets afterwards: a permanently failing dataset makes
    // every run "partial", and holding the clock back for it would make the
    // scheduler refetch the whole catalog on every wake.
    if (isUnrestrictedCatalogRun(opts)) statePatch.lastFullPassAt = st.catalogCheckedAt;
  }
  // A single-dataset run says nothing about the health of the catalog-wide
  // schedule, so it must not mask a failing scheduler in the `stale` signal.
  if ((status === "success" || status === "partial") && !opts.datasetId) statePatch.lastSuccessAt = now;
  if (st.counters.updated > 0) statePatch.lastDataChangeAt = now;

  console.log(
    `[sync] Done (${status}). processed=${st.counters.processed} updated=${st.counters.updated} ` +
      `skipped=${st.counters.skipped} deferred=${st.changed.deferred.length} failed=${st.counters.failed}` +
      ` added=${st.changed.added.length} removed=${st.changed.removed.length}.`,
  );

  await endRun(ctx, {
    status,
    error,
    counters: st.counters,
    failures: st.failures,
    changed: st.changed,
    statePatch,
    notifyIds: [
      ...new Set([...st.changed.updated, ...st.changed.added, ...st.changed.removed, ...st.notifyExtra]),
    ],
  });

  return toResult(st, status, error, ctx.logId);
}

/** Dry run: catalog pass + change detection, no writes, no lock, no downloads. */
async function runDryRun(opts: RunSyncOptions): Promise<RunSyncResult> {
  const st = newRunState();
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", () => controller.abort(opts.signal?.reason), { once: true });
  }
  const { scope, stored } = await catalogPhase(opts, st, controller.signal, false);
  const plan = planChanges(scope, stored, opts);

  st.counters.total += scope.length;
  st.counters.skipped = plan.skipped.length;
  st.counters.succeeded = plan.skipped.length;
  st.counters.processed += plan.skipped.length + plan.deferred.length;
  st.counters.updated = plan.download.length;
  st.changed.updated.push(...plan.download.map((d) => d.dataset_id));
  st.changed.deferred.push(...plan.deferred.map((d) => d.dataset_id));
  return { ...toResult(st, "success", null, 0), dryRun: true };
}

/**
 * Run a sync to completion. Acquires the lock (throws SyncAlreadyRunningError
 * when another run holds it), records the run in SyncLog, and resolves with
 * the result — including `status: "failed"` for whole-run failures.
 */
export async function runSync(opts: RunSyncOptions): Promise<RunSyncResult> {
  if (opts.dryRun) {
    try {
      return await runDryRun(opts);
    } finally {
      // A dry run takes no lock; a handed-over one must not leak.
      await opts.lock?.release();
    }
  }
  const ctx = await beginRun({
    trigger: opts.trigger,
    scope: describeScope(opts),
    lock: opts.lock,
    signal: opts.signal,
  });
  return executeRun(ctx, opts);
}

export type StartSyncResult =
  | { started: true; runId: number }
  | { started: false; since: Date };

/**
 * Start a sync in the background. The lock is acquired and the SyncLog row
 * created BEFORE this returns, so an HTTP caller can answer 202 (started) or
 * 409 (already running) truthfully and a poller never sees a "not running"
 * gap. The run itself is detached: it never throws (failures are recorded on
 * its SyncLog row) and releases the lock when done.
 *
 * Errors starting the run (e.g. the database is down) propagate.
 */
export async function startSyncInBackground(
  opts: Omit<RunSyncOptions, "lock" | "dryRun">,
): Promise<StartSyncResult> {
  let ctx: RunContext;
  try {
    ctx = await beginRun({ trigger: opts.trigger, scope: describeScope(opts), signal: opts.signal });
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) return { started: false, since: err.since };
    throw err;
  }
  void executeRun(ctx, opts).catch((err) => {
    console.error("[sync] Background run crashed:", err);
  });
  return { started: true, runId: ctx.logId };
}
