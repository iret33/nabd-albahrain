/**
 * POST /api/sync — kicks off a sync run (Phase 6).
 *
 * Auth: `Authorization: Bearer $SYNC_TOKEN` (the spec'd contract for
 * external/scripted callers), OR the `admin_token` cookie set by
 * `/admin/login` (lets the browser-based admin dashboard call this exact
 * endpoint without ever seeing `SYNC_TOKEN` — see `src/lib/sync/auth.ts`).
 *
 * Query params:
 *   ?dataset=<id>   only re-sync this one dataset (still refreshes the
 *                    full catalog metadata first, same as any run — that's
 *                    `runSync()`'s existing behavior, unchanged here).
 *   ?force=1         re-fetch records even if unchanged since last sync.
 *
 * Responds immediately — 202 `{ started: true }` once a run has been
 * kicked off, or 409 if the lock is already held by a run that isn't
 * stale — and never blocks the HTTP response on the sync itself
 * (fire-and-forget; `runSync()`'s own `SyncLock` row is the real mutex
 * that guarantees only one run executes even under concurrent requests —
 * see the comment above the `void runSync(...)` call below).
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { runSync } from "@/lib/sync/engine";
import { getLockState, SyncAlreadyRunningError } from "@/lib/sync/lock";
import { isSyncRequestAuthorized } from "@/lib/sync/auth";

export const dynamic = "force-dynamic";

/**
 * Revalidates the `unstable_cache` tags Phase 4/5's public pages read
 * from (`src/lib/queries.ts`) once a run finishes, so they pick up
 * whatever changed instead of waiting for cache expiry. `"datasets"`
 * covers every list/aggregate query; `dataset:{id}` covers that one
 * dataset's detail + records-page queries.
 *
 * For a single-dataset sync only that dataset's tag is touched. For a
 * full sync, every dataset currently on file is revalidated —
 * `revalidateTag` just marks cache entries stale (no I/O), and reading
 * the post-sync id list from the DB (rather than trying to thread a list
 * through `runSync()`'s return value) correctly picks up datasets the
 * catalog fetch newly discovered this run too.
 */
async function revalidateAfterSync(datasetId?: string): Promise<void> {
  revalidateTag("datasets");
  if (datasetId) {
    revalidateTag(`dataset:${datasetId}`);
    return;
  }
  const rows = await prisma.dataset.findMany({ select: { id: true } });
  for (const row of rows) {
    revalidateTag(`dataset:${row.id}`);
  }
}

function parseForce(searchParams: URLSearchParams): boolean {
  const raw = searchParams.get("force");
  return raw === "1" || raw === "true";
}

export async function POST(req: NextRequest) {
  if (!isSyncRequestAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const datasetId = searchParams.get("dataset") || undefined;
  const force = parseForce(searchParams);

  const lock = await getLockState();
  if (lock.running && !lock.stale) {
    return NextResponse.json(
      { started: false, error: "sync_already_running", since: lock.since },
      { status: 409 },
    );
  }

  // Fire-and-forget — the HTTP response below does not wait on this.
  // `runSync()` calls `acquireLock()` itself, which is the real,
  // authoritative mutex (the `getLockState()` check above is only a
  // fast-path so a request that's clearly redundant gets an immediate
  // 409 instead of silently queueing). If two requests race within the
  // gap between that check and this call, the loser's `acquireLock()`
  // throws `SyncAlreadyRunningError` here — caught and logged, not
  // rethrown, since its own request has already been answered (202 or
  // 409) by the time this settles.
  void runSync({ datasetId, force, trigger: "api" })
    .then(() => revalidateAfterSync(datasetId))
    .catch((err) => {
      if (err instanceof SyncAlreadyRunningError) {
        console.warn(`[api/sync] ${err.message}`);
        return;
      }
      console.error("[api/sync] Sync run crashed:", err);
    });

  return NextResponse.json({ started: true }, { status: 202 });
}
