/**
 * GET /api/health/ready — readiness / deep health, for uptime monitors
 * (UptimeRobot keyword, healthchecks.io...). NOT for the Docker liveness
 * check: `/api/health` deliberately never touches Postgres so a database
 * blip cannot make Docker restart the container.
 *
 * Status codes:
 *   503  only when the database does not answer within 2s
 *   200  otherwise; `ok: false, status: "degraded"` when the last catalog-wide
 *        sync failed, or the newest synced data is older than 36h, or nothing
 *        has been synced yet — so a monitor can alert without restarts.
 *
 * Exposes no secrets and no error text.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getLockState } from "@/lib/sync/lock";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const DB_PING_TIMEOUT_MS = 2_000;
const MAX_DATA_AGE_HOURS = 36;

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
    version: process.env.GIT_SHA ?? null,
  };

  if (!(await pingDatabase())) {
    return NextResponse.json({ ok: false, status: "down", db: "down", ...base }, { status: 503, headers: NO_STORE });
  }

  try {
    const [lock, lastRun, agg] = await Promise.all([
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
    ]);

    const lastSyncedAt = agg._max.lastSyncedAt;
    const ageHours = lastSyncedAt ? Math.round(((Date.now() - lastSyncedAt.getTime()) / 3_600_000) * 10) / 10 : null;

    const reasons: string[] = [];
    if (lastRun?.status === "failed") reasons.push("last_sync_failed");
    if (ageHours === null) reasons.push("no_data_synced");
    else if (ageHours > MAX_DATA_AGE_HOURS) reasons.push("data_older_than_36h");

    return NextResponse.json(
      {
        ok: reasons.length === 0,
        status: reasons.length === 0 ? "ok" : "degraded",
        reasons,
        db: "up",
        sync: {
          running: lock.running && !lock.stale,
          since: lock.running ? lock.since : null,
          stale: lock.stale,
          lastStatus: lastRun?.status ?? null,
          lastFinishedAt: lastRun?.finishedAt ?? null,
          lastSyncedAt,
          ageHours,
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
