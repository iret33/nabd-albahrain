/**
 * GET /api/health/ready — readiness / deep health, for uptime monitors
 * (UptimeRobot keyword, healthchecks.io...). NOT for the Docker liveness
 * check: `/api/health` deliberately never touches Postgres so a database
 * blip cannot make Docker restart the container.
 *
 * Status codes:
 *   503  only when the database does not answer within 2s
 *   200  otherwise; `ok: false, status: "degraded"` when
 *          - the last catalog-wide sync failed (`last_sync_failed`),
 *          - nothing has ever succeeded (`no_data_synced`),
 *          - the last success is older than the freshness threshold
 *            (`sync_stale`; the SAME clock and threshold as /api/freshness:
 *            SyncState.lastSuccessAt vs getStaleAfterMs(), i.e. twice the
 *            scheduler interval, 48h when the scheduler is off), or
 *          - a real share of the datasets cannot be downloaded
 *            (`datasets_failing`: at least 3 and at least 10% of the live
 *            datasets are in "error", e.g. the portal's export endpoint is
 *            down). One or two sticky failures only show up in `warnings`,
 *            so a single poison dataset does not keep the monitor red.
 *
 * The age is measured from the last successful RUN, not from the newest
 * dataset change: a portal that publishes nothing for a weekend is healthy.
 * `sync.ageHours` is that age; `sync.lastSyncedAt` (the newest dataset sync)
 * and `sync.lastDataChangeAt` stay for information.
 *
 * Exposes no secrets and no error text.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStaleAfterMs } from "@/lib/sync/config";
import { isStale } from "@/lib/sync/freshness";
import { getLockState } from "@/lib/sync/lock";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const DB_PING_TIMEOUT_MS = 2_000;
/** `datasets_failing` needs at least this many datasets in "error"... */
const FAILING_MIN_COUNT = 3;
/** ...and at least this share of the live ones. */
const FAILING_MIN_SHARE = 0.1;

async function pingDatabase(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("db ping timed out")), DB_PING_TIMEOUT_MS);
    });
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  const base = {
    uptimeSec: Math.round(process.uptime()),
    // `||`, not `??`: an unset ARG/ENV arrives as "" and must read as "unknown".
    version: process.env.GIT_SHA?.trim() || null,
  };

  if (!(await pingDatabase())) {
    return NextResponse.json({ ok: false, status: "down", db: "down", ...base }, { status: 503, headers: NO_STORE });
  }

  try {
    const [lock, lastRun, agg, state, counts] = await Promise.all([
      getLockState(),
      // The newest finished catalog-wide run: a mistyped `?dataset=` or a
      // recompute must not flip the monitor to "degraded".
      prisma.syncLog.findFirst({
        where: {
          status: { not: "running" },
          OR: [
            { scope: null },
            { NOT: [{ scope: { equals: "recompute" } }, { scope: { startsWith: "dataset:" } }] },
          ],
        },
        orderBy: { id: "desc" },
        select: { status: true, finishedAt: true },
      }),
      prisma.dataset.aggregate({ _max: { lastSyncedAt: true } }),
      prisma.syncState.findUnique({
        where: { id: 1 },
        select: { lastSuccessAt: true, lastDataChangeAt: true },
      }),
      prisma.$queryRaw<Array<{ failing: number; live: number }>>`
        SELECT (count(*) FILTER (WHERE "syncStatus" = 'error'))::int AS "failing", count(*)::int AS "live"
        FROM "Dataset" WHERE "removedAt" IS NULL`,
    ]);

    const nowMs = Date.now();
    const lastSuccessAt = state?.lastSuccessAt ?? null;
    const ageHours = lastSuccessAt ? Math.round(((nowMs - lastSuccessAt.getTime()) / 3_600_000) * 10) / 10 : null;
    const failing = counts[0]?.failing ?? 0;
    const live = counts[0]?.live ?? 0;

    const reasons: string[] = [];
    const warnings: string[] = [];
    if (lastRun?.status === "failed") reasons.push("last_sync_failed");
    if (lastSuccessAt === null) reasons.push("no_data_synced");
    else if (isStale(lastSuccessAt, nowMs, getStaleAfterMs())) reasons.push("sync_stale");
    if (failing >= FAILING_MIN_COUNT && failing >= live * FAILING_MIN_SHARE) reasons.push("datasets_failing");
    else if (failing > 0) warnings.push("datasets_failing");

    return NextResponse.json(
      {
        ok: reasons.length === 0,
        status: reasons.length === 0 ? "ok" : "degraded",
        reasons,
        warnings,
        db: "up",
        sync: {
          running: lock.running && !lock.stale,
          since: lock.running ? lock.since : null,
          stale: lock.stale,
          lastStatus: lastRun?.status ?? null,
          lastFinishedAt: lastRun?.finishedAt ?? null,
          lastSuccessAt,
          lastDataChangeAt: state?.lastDataChangeAt ?? null,
          lastSyncedAt: agg._max.lastSyncedAt,
          ageHours,
          failingDatasets: failing,
        },
        ...base,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    // The ping passed but a read failed: report degraded, not a crash.
    console.error("[api/health/ready] failed:", err);
    return NextResponse.json(
      { ok: false, status: "degraded", reasons: ["read_failed"], db: "up", ...base },
      { headers: NO_STORE },
    );
  }
}
