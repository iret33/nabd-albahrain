/**
 * The sync engine: fetches the full data.gov.bh catalog, upserts dataset
 * metadata, then fetches + stores records for the datasets in scope
 * (all / --limit N / --dataset <id>), skipping unchanged datasets unless
 * --force is passed. See the module-level comments in each imported file
 * for the specifics of each step.
 *
 * Callable directly (e.g. from a later API route) via runSync(opts), and
 * from the CLI via cli.ts.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fetchDatasetExport, fetchFullCatalog } from "./ods-client";
import { computeDerivedFields } from "./derived";
import { acquireLock, releaseLock } from "./lock";
import { chunk, computeTitleClean, mapWithConcurrency } from "./utils";
import type { CatalogDataset, CatalogField } from "./schemas";

const INSERT_BATCH_SIZE = 1000;
const MAX_ROWS_HARD_CAP = 300_000;
const MAX_ROWS_STORED_WHEN_CAPPED = 50_000;
const RECORD_SYNC_CONCURRENCY = Number(process.env.SYNC_CONCURRENCY) || 3;

export interface RunSyncOptions {
  /** Only sync records for the first N datasets (catalog order). */
  limit?: number;
  /** Only sync records for this one dataset_id. */
  datasetId?: string;
  /** Re-fetch records even if the source hasn't been modified since our last sync. */
  force?: boolean;
  /** Recorded on the SyncLog row: "cli" | "api" | etc. */
  trigger: string;
}

export interface RunSyncResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  failures: Array<{ datasetId: string; error: string }>;
  syncLogId: number;
}

type DatasetOutcome =
  | { status: "ok" | "partial" | "skipped" }
  | { status: "error"; error: string };

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Derive the Dataset metadata columns from one catalog entry. */
function metadataFromCatalogEntry(entry: CatalogDataset) {
  const meta = entry.metas?.default;
  const title = meta?.title?.trim() || entry.dataset_id;
  const theme = meta?.theme && meta.theme.length > 0 ? meta.theme[0] : null;
  const modified = meta?.modified ? new Date(meta.modified) : null;

  return {
    title,
    titleClean: computeTitleClean(title),
    description: meta?.description ?? null,
    theme,
    publisher: meta?.publisher ?? null,
    recordsCount: meta?.records_count ?? 0,
    fieldsJson: entry.fields ?? [],
    sourceModified: modified && !isNaN(modified.getTime()) ? modified : null,
  };
}

/** Step (b): upsert every dataset's metadata. Never touches sync-state columns. */
async function upsertCatalogMetadata(catalog: CatalogDataset[]): Promise<void> {
  for (const entry of catalog) {
    const meta = metadataFromCatalogEntry(entry);
    await prisma.dataset.upsert({
      where: { id: entry.dataset_id },
      create: {
        id: entry.dataset_id,
        ...meta,
        fieldsJson: meta.fieldsJson as Prisma.InputJsonValue,
      },
      update: {
        ...meta,
        fieldsJson: meta.fieldsJson as Prisma.InputJsonValue,
      },
    });
  }
}

/** Steps (c)-(f) for one dataset. Never throws — errors are returned as a result. */
async function syncOneDataset(datasetId: string, force: boolean): Promise<DatasetOutcome> {
  try {
    const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
    if (!dataset) {
      // Shouldn't happen — we just upserted every catalog entry — but stay defensive.
      return { status: "error", error: "Dataset row missing after catalog upsert" };
    }

    if (
      !force &&
      dataset.lastSyncedAt &&
      dataset.sourceModified &&
      dataset.lastSyncedAt.getTime() >= dataset.sourceModified.getTime()
    ) {
      return { status: "skipped" };
    }

    const records = await fetchDatasetExport(datasetId);

    const partial = records.length > MAX_ROWS_HARD_CAP;
    const toStore = partial ? records.slice(0, MAX_ROWS_STORED_WHEN_CAPPED) : records;

    await prisma.$transaction(
      async (tx) => {
        await tx.datasetRecord.deleteMany({ where: { datasetId } });
        for (const batch of chunk(toStore, INSERT_BATCH_SIZE)) {
          await tx.datasetRecord.createMany({
            data: batch.map((row) => ({
              datasetId,
              data: row as Prisma.InputJsonValue,
            })),
          });
        }
      },
      { timeout: 120_000 },
    );

    // Derived fields are computed over the FULL fetched array (not just
    // `toStore`) so Phase 3 can produce accurate stats even when storage
    // was capped by the size guard. `dataset.fieldsJson` is the same raw
    // ODS `fields[]` array upserted from the catalog entry above — Phase 3
    // needs field type/label/annotations to classify and label the chart,
    // so this call site was extended (from Phase 2's `(datasetId, records)`
    // stub signature) to also pass it through.
    const derived = await computeDerivedFields(
      datasetId,
      records,
      (dataset.fieldsJson as unknown as CatalogField[]) ?? [],
    );

    await prisma.dataset.update({
      where: { id: datasetId },
      data: {
        sourceCount: toStore.length,
        syncStatus: partial ? "partial" : "ok",
        syncError: null,
        lastSyncedAt: new Date(),
        // These columns are nullable (not-yet-computed until Phase 3 fills
        // in computeDerivedFields). Prisma.DbNull writes an actual SQL
        // NULL; Prisma.JsonNull would instead store the JSON literal
        // `null`, which reads back as "computed, and the answer is null"
        // — not what an un-implemented stub means.
        statsJson: (derived.statsJson ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
        vizConfig: (derived.vizConfig ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
        chartData: (derived.chartData ?? Prisma.DbNull) as Prisma.InputJsonValue,
        summaryAr: derived.summaryAr,
      },
    });

    return { status: partial ? "partial" : "ok" };
  } catch (err) {
    const message = toErrorMessage(err);
    // Best-effort: record the failure on the Dataset row too, but don't let
    // a failure here (e.g. DB hiccup) mask the original error.
    await prisma.dataset
      .update({
        where: { id: datasetId },
        data: { syncStatus: "error", syncError: message.slice(0, 2000) },
      })
      .catch(() => {});
    return { status: "error", error: message };
  }
}

export async function runSync(opts: RunSyncOptions): Promise<RunSyncResult> {
  await acquireLock();

  const startedAt = new Date();
  try {
    console.log("[sync] Fetching full catalog...");
    const catalog = await fetchFullCatalog();
    console.log(`[sync] Catalog fetched: ${catalog.length} datasets.`);

    console.log("[sync] Upserting dataset metadata...");
    await upsertCatalogMetadata(catalog);

    let scope: CatalogDataset[];
    if (opts.datasetId) {
      const match = catalog.find((d) => d.dataset_id === opts.datasetId);
      if (!match) {
        throw new Error(
          `--dataset ${opts.datasetId} was not found in the live catalog (${catalog.length} datasets).`,
        );
      }
      scope = [match];
    } else if (opts.limit && opts.limit > 0) {
      scope = catalog.slice(0, opts.limit);
    } else {
      scope = catalog;
    }

    console.log(
      `[sync] Syncing records for ${scope.length} dataset(s) ` +
        `(concurrency ${RECORD_SYNC_CONCURRENCY}${opts.force ? ", forced" : ""})...`,
    );

    const failures: Array<{ datasetId: string; error: string }> = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    await mapWithConcurrency(
      scope,
      RECORD_SYNC_CONCURRENCY,
      async (entry) => {
        const outcome = await syncOneDataset(entry.dataset_id, Boolean(opts.force));
        if (outcome.status === "error") {
          failed++;
          failures.push({ datasetId: entry.dataset_id, error: outcome.error });
          console.error(`[sync]   FAILED ${entry.dataset_id}: ${outcome.error}`);
        } else if (outcome.status === "skipped") {
          skipped++;
          succeeded++; // unchanged is a successful outcome, not a failure
          console.log(`[sync]   skip   ${entry.dataset_id} (unchanged)`);
        } else {
          succeeded++;
          console.log(`[sync]   ${outcome.status === "partial" ? "partial" : "ok"}     ${entry.dataset_id}`);
        }
        return outcome;
      },
      (entry, _index, err) => {
        // A worker should never throw (syncOneDataset catches internally),
        // but stay defensive in case something outside it does.
        const message = toErrorMessage(err);
        failed++;
        failures.push({ datasetId: entry.dataset_id, error: message });
        console.error(`[sync]   FAILED ${entry.dataset_id} (unexpected): ${message}`);
        return { status: "error", error: message } as DatasetOutcome;
      },
    );

    const syncLog = await prisma.syncLog.create({
      data: {
        trigger: opts.trigger,
        startedAt,
        finishedAt: new Date(),
        processed: scope.length,
        succeeded,
        failed,
        failuresJson: failures as unknown as Prisma.InputJsonValue,
      },
    });

    console.log(
      `[sync] Done. processed=${scope.length} succeeded=${succeeded} ` +
        `(of which skipped=${skipped}) failed=${failed}.`,
    );

    return {
      processed: scope.length,
      succeeded,
      failed,
      skipped,
      failures,
      syncLogId: syncLog.id,
    };
  } finally {
    await releaseLock();
  }
}
