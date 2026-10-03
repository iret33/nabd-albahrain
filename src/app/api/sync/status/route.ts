/**
 * GET /api/sync/status — current SyncLock state + the latest SyncLog row.
 * Polled by the `/admin` dashboard every 3s while a sync is (or might be)
 * running. Same combined auth as `POST /api/sync` — see
 * `src/lib/sync/auth.ts` — though in practice the admin dashboard's poll
 * relies on the signed admin-session cookie it already carries
 * (`ADMIN_COOKIE_NAME` in `src/lib/admin-session.ts`), not a bearer header.
 *
 * Shape: `{ lock, latestLog }`. `lock` is `{ running, since, heartbeatAt,
 * stale }` (stale = the holder's heartbeat is older than 10 minutes, i.e. a
 * crashed run); `latestLog` is the newest SyncLog row INCLUDING a run that is
 * still in flight (`status: "running"`), with its progress counters,
 * `status`, `error`, `scope`, `total`, `skipped`, `updated` and
 * `changedJson`.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getLockState } from "@/lib/sync/lock";
import { authorizeSyncRequest, syncAuthFailureResponse } from "@/lib/sync/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authorizeSyncRequest(req);
  if (!auth.ok) return syncAuthFailureResponse(auth) as NextResponse;

  const [lock, latestLog] = await Promise.all([
    getLockState(),
    prisma.syncLog.findFirst({ orderBy: [{ startedAt: "desc" }, { id: "desc" }] }),
  ]);

  return NextResponse.json({ lock, latestLog }, { headers: { "Cache-Control": "no-store" } });
}
