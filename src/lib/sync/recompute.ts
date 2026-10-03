/**
 * Re-derive stats / chart / summary columns from the records ALREADY STORED,
 * with no network access.
 *
 * Why: when the derivation logic changes (DERIVED_VERSION in derived.ts) the
 * persisted statsJson/vizConfig/chartData/summaryAr of every dataset are stale,
 * but a forced full sync (~7 minutes of portal traffic) is a heavy way to fix
 * a pure computation change.
 *
 * Only datasets whose stored rows are the COMPLETE export are eligible
 * (syncStatus "ok"). A "partial" dataset keeps at most 50,000 of its rows, so
 * deriving from them would be wrong; those are listed and need a forced sync.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeDerivedFields, DERIVED_VERSION } from "./derived";
import { SyncAbortedError, SyncIntegrityError, describeError } from "./errors";
import { SyncAlreadyRunningError, type SyncLockHandle } from "./lock";
import { emptyChangedSets, type RunCounters, type RunFailure } from "./log";
import { beginRun, createProgressWriter, endRun, statusFromError, type RunContext } from "./run";
import type { CatalogField } from "./schemas";

const LOAD_BATCH_SIZE = 5000;

export interface RunRecomputeOptions {
  /** Recorded on the SyncLog row. */
  trigger: string;
  /** A lock the caller already acquired; the run takes ownership and releases it. */
  lock?: SyncLockHandle;
  /** Only this dataset. */
  datasetId?: string;
  /** Recompute even datasets already at DERIVED_VERSION. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface RunRecomputeResult {
  /** Datasets considered. */
  processed: number;
  /** Datasets whose derived columns were rewritten. */
  updated: number;
  failed: number;
  failures: RunFailure[];
  /** "partial" datasets with a stale derivedVersion: stored rows are capped, so they need a forced sync. */
  skippedPartial: string[];
  syncLogId: number;
  status: "success" | "partial" | "failed" | "aborted";
  error?: string;
}

/** Datasets whose derived columns are out of date and can be recomputed locally. */
function eligibleWhere(opts: { datasetId?: string; force?: boolean }): Prisma.DatasetWhereInput {
  return {
    syncStatus: "ok",
    sourceCount: { gt: 0 },
    ...(opts.datasetId ? { id: opts.datasetId } : {}),
    ...(opts.force
      ? {}
      : { OR: [{ derivedVersion: null }, { derivedVersion: { not: DERIVED_VERSION } }] }),
  };
}

/** How many datasets a recompute would touch (used by the scheduler). */
export async function countDatasetsNeedingRecompute(): Promise<number> {
  return prisma.dataset.count({ where: eligibleWhere({}) });
}

async function loadStoredRecords(datasetId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: bigint | undefined;
  while (true) {
    const rows = await prisma.datasetRecord.findMany({
      where: { datasetId, ...(cursor !== undefined ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: LOAD_BATCH_SIZE,
      select: { id: true, data: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) out.push(row.data as Record<string, unknown>);
    cursor = rows[rows.length - 1].id;
    if (rows.length < LOAD_BATCH_SIZE) break;
  }
  return out;
}

/** Run everything after the lock/log row exist. Never throws. */
async function executeRecompute(ctx: RunContext, opts: RunRecomputeOptions): Promise<RunRecomputeResult> {
  const signal = ctx.abort.signal;
  const counters: RunCounters = { total: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, updated: 0 };
  const failures: RunFailure[] = [];
  const changed = emptyChangedSets();
  const skippedPartial: string[] = [];
  let status: RunRecomputeResult["status"] = "success";
  let error: string | null = null;

  try {
    const targets = await prisma.dataset.findMany({
      where: eligibleWhere(opts),
      select: { id: true, fieldsJson: true, sourceCount: true },
      orderBy: { id: "asc" },
    });

    // Capped ("partial") datasets cannot be recomputed locally; report them.
    const partial = await prisma.dataset.findMany({
      where: {
        syncStatus: "partial",
        ...(opts.datasetId ? { id: opts.datasetId } : {}),
        ...(opts.force ? {} : { OR: [{ derivedVersion: null }, { derivedVersion: { not: DERIVED_VERSION } }] }),
      },
      select: { id: true },
    });
    skippedPartial.push(...partial.map((p) => p.id));
    if (skippedPartial.length > 0) {
      console.warn(
        `[recompute] Skipping ${skippedPartial.length} partial dataset(s) (stored rows are capped; ` +
          `they need a forced sync): ${skippedPartial.slice(0, 10).join(", ")}${skippedPartial.length > 10 ? ", ..." : ""}`,
      );
    }

    counters.total = targets.length;
    counters.skipped = skippedPartial.length;
    const progress = createProgressWriter(ctx.logId, counters);
    await progress.flush();
    console.log(`[recompute] ${targets.length} dataset(s) to re-derive (DERIVED_VERSION ${DERIVED_VERSION}).`);

    for (const target of targets) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new SyncAbortedError();
      try {
        const records = await loadStoredRecords(target.id);
        if (records.length !== target.sourceCount) {
          throw new SyncIntegrityError(
            `Stored rows (${records.length}) do not match sourceCount (${target.sourceCount}); a forced sync is needed`,
          );
        }
        const derived = await computeDerivedFields(target.id, records, (target.fieldsJson ?? []) as unknown as CatalogField[]);
        await prisma.dataset.update({
          where: { id: target.id },
          data: {
            statsJson: (derived.statsJson ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
            vizConfig: (derived.vizConfig ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
            chartData: (derived.chartData ?? Prisma.DbNull) as Prisma.InputJsonValue,
            summaryAr: derived.summaryAr,
            derivedVersion: DERIVED_VERSION,
          },
        });
        counters.updated++;
        counters.succeeded++;
        changed.updated.push(target.id);
        console.log(`[recompute]   ok     ${target.id}`);
      } catch (err) {
        if (err instanceof SyncAbortedError) throw err;
        console.error(`[recompute] ${target.id} failed:`, err);
        const message = describeError(err).message;
        counters.failed++;
        failures.push({ datasetId: target.id, error: message });
        if (err instanceof SyncIntegrityError) {
          // The stored copy is inconsistent. Leave "ok" so it stops being
          // eligible for recompute (the scheduler would otherwise retry it
          // every few minutes forever); the next sync retries "error"
          // datasets by re-downloading them, which repairs it.
          await prisma.dataset
            .update({ where: { id: target.id }, data: { syncStatus: "error", syncError: message } })
            .catch((updateErr) => console.error(`[recompute] Could not flag ${target.id}:`, updateErr));
        }
      }
      counters.processed++;
      progress.tick();
    }
  } catch (err) {
    const described = statusFromError(err, signal);
    status = described.status;
    error = described.error;
  }

  if (status === "success" && counters.failed > 0) {
    status = counters.succeeded > 0 ? "partial" : "failed";
    error = `${counters.failed} dataset(s) could not be recomputed`;
  }

  await endRun(ctx, {
    status,
    error,
    counters,
    failures,
    changed,
    // Recompute never talks to the portal and publishes no new portal data,
    // so it moves none of the SyncState clocks.
    statePatch: {},
    notifyIds: changed.updated,
  });

  return {
    processed: counters.processed,
    updated: counters.updated,
    failed: counters.failed,
    failures,
    skippedPartial,
    syncLogId: ctx.logId,
    status,
    ...(error ? { error } : {}),
  };
}

/**
 * Re-derive stale datasets from stored rows. Acquires the lock (throws
 * SyncAlreadyRunningError when another run holds it) and resolves with the
 * result; whole-run failures are returned as `status`, not thrown.
 */
export async function runRecompute(opts: RunRecomputeOptions): Promise<RunRecomputeResult> {
  const ctx = await beginRun({
    trigger: opts.trigger,
    scope: "recompute",
    lock: opts.lock,
    signal: opts.signal,
  });
  return executeRecompute(ctx, opts);
}

export type RecomputeStart = { started: true; runId: number } | { started: false; since: Date };

/** Like startSyncInBackground: lock + SyncLog row first, then run detached. */
export async function startRecomputeInBackground(
  opts: Omit<RunRecomputeOptions, "lock">,
): Promise<RecomputeStart> {
  let ctx: RunContext;
  try {
    ctx = await beginRun({ trigger: opts.trigger, scope: "recompute", signal: opts.signal });
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) return { started: false, since: err.since };
    throw err;
  }
  void executeRecompute(ctx, opts).catch((err) => {
    console.error("[recompute] Background run crashed:", err);
  });
  return { started: true, runId: ctx.logId };
}
