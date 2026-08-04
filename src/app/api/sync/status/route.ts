/**
 * GET /api/sync/status — current SyncLock state + the latest SyncLog row.
 * Polled by the `/admin` dashboard every 3s while a sync is (or might be)
 * running (Phase 6). Same combined auth as `POST /api/sync` — see
 * `src/lib/sync/auth.ts` — though in practice the admin dashboard's poll
 * relies on the `admin_token` cookie it already carries, not a bearer
 * header.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getLockState } from "@/lib/sync/lock";
import { isSyncRequestAuthorized } from "@/lib/sync/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isSyncRequestAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [lock, latestLog] = await Promise.all([
    getLockState(),
    prisma.syncLog.findFirst({ orderBy: { startedAt: "desc" } }),
  ]);

  return NextResponse.json({ lock, latestLog });
}
