/**
 * GET /api/freshness[?dataset=<id>][&strict=1] — PUBLIC (no token): how fresh
 * the data is, whether a sync is running (and how far along), when the next
 * public refresh is allowed, and whether the data is stale.
 *
 * Polled every ~2s by the refresh button while a run is in flight, so it only
 * reads primary-key / tiny-table rows (the catalog-wide part is shared between
 * callers for about a second, see getFreshness). Never cached by the browser.
 *
 * `?strict=1` answers 503 while the data is stale, so an uptime monitor can
 * alert on "the nightly sync silently stopped" (a cron `curl` only ever sees
 * the 202, never the outcome).
 *
 * Additive fields beyond the original contract: `lastRun` (id, scope,
 * trigger, status, updated/failed/deferred COUNTS of the newest finished run)
 * and, with ?dataset=, `syncStatus`, `failed`, `deferred`, `lastRunId`. They
 * let the button say what really happened instead of "nothing new" when a
 * large dataset was deferred or a download failed.
 */

import { NextRequest, NextResponse } from "next/server";
import { getFreshness } from "@/lib/sync/freshness";
import { isPublicDatasetId } from "@/lib/sync/refresh-policy";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function isTrue(value: string | null): boolean {
  return value === "1" || value === "true";
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawDataset = searchParams.get("dataset");
  // An id that cannot exist (over-long, a NUL byte or other control character,
  // a lone surrogate) reads as an unknown dataset instead of reaching Postgres,
  // where a NUL byte would be a 500 plus a stack trace in the log.
  const datasetId = isPublicDatasetId(rawDataset) ? rawDataset : undefined;
  const strict = isTrue(searchParams.get("strict"));

  try {
    const snapshot = await getFreshness({ datasetId });
    if (rawDataset && !datasetId) snapshot.dataset = null;
    return NextResponse.json(snapshot, {
      status: strict && snapshot.stale ? 503 : 200,
      headers: NO_STORE,
    });
  } catch (err) {
    console.error("[api/freshness] failed:", err);
    return NextResponse.json({ status: "error" }, { status: 500, headers: NO_STORE });
  }
}
