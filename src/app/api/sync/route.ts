/**
 * POST /api/sync — kicks off a sync run (token-gated; for cron, scripts and
 * the admin dashboard).
 *
 * Auth: `Authorization: Bearer $SYNC_TOKEN` (the spec'd contract for
 * external/scripted callers), OR the `admin_token` cookie set by
 * `/admin/login` (lets the browser-based admin dashboard call this exact
 * endpoint without ever seeing `SYNC_TOKEN` — see `src/lib/sync/auth.ts`).
 *
 * Query params:
 *   ?dataset=<id>   only re-sync this one dataset (one catalog-entry request,
 *                   not the whole catalog).
 *   ?force=1        re-fetch records even if the source version is unchanged
 *                   (admin-only: the public refresh endpoint can never force).
 *   ?recompute=1    no network: re-derive stats/charts from the stored records
 *                   of datasets whose derived data is out of date (combine with
 *                   ?dataset= for one, ?force=1 for all).
 *
 * The sync lock is acquired and the SyncLog row created BEFORE answering, so
 * the answer is truthful:
 *   202 { started: true, runId }
 *   409 { started: false, error: "sync_already_running", since }
 *   400 { error: "invalid_dataset" } for an id that cannot exist (over 200
 *       characters, a NUL byte or other control character, a lone surrogate)
 * The run itself continues in the background; cache invalidation happens at
 * the end of the run (src/lib/sync/notify.ts -> POST /api/revalidate).
 */

import { NextRequest, NextResponse } from "next/server";
import { startSyncInBackground } from "@/lib/sync/engine";
import { startRecomputeInBackground } from "@/lib/sync/recompute";
import { authorizeSyncRequest, syncAuthFailureResponse } from "@/lib/sync/auth";
import { isPublicDatasetId } from "@/lib/sync/refresh-policy";

export const dynamic = "force-dynamic";

function isTrue(searchParams: URLSearchParams, name: string): boolean {
  const raw = searchParams.get(name);
  return raw === "1" || raw === "true";
}

export async function POST(req: NextRequest) {
  const auth = await authorizeSyncRequest(req);
  if (!auth.ok) return syncAuthFailureResponse(auth) as NextResponse;

  const { searchParams } = new URL(req.url);
  const datasetId = searchParams.get("dataset") || undefined;
  // Same id rule as the public routes: a NUL byte would otherwise start a run
  // that dies on its first query and leaves a failed row behind.
  if (datasetId !== undefined && !isPublicDatasetId(datasetId)) {
    return NextResponse.json({ error: "invalid_dataset" }, { status: 400 });
  }
  const force = isTrue(searchParams, "force");
  const recompute = isTrue(searchParams, "recompute");

  try {
    const result = recompute
      ? await startRecomputeInBackground({ trigger: "api", datasetId, force })
      : await startSyncInBackground({ trigger: "api", datasetId, force });

    if (!result.started) {
      return NextResponse.json(
        { started: false, error: "sync_already_running", since: result.since },
        { status: 409 },
      );
    }
    return NextResponse.json({ started: true, runId: result.runId }, { status: 202 });
  } catch (err) {
    console.error("[api/sync] Could not start the run:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
