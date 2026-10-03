/**
 * GET /api/freshness[?dataset=<id>][&strict=1] — PUBLIC (no token): how fresh
 * the data is, whether a sync is running (and how far along), when the next
 * public refresh is allowed, and whether the data is stale.
 *
 * Polled every ~2s by the refresh button while a run is in flight, so it only
 * reads primary-key / tiny-table rows. Never cached.
 *
 * `?strict=1` answers 503 while the data is stale, so an uptime monitor can
 * alert on "the nightly sync silently stopped" (a cron `curl` only ever sees
 * the 202, never the outcome).
 */

import { NextRequest, NextResponse } from "next/server";
import { getFreshness } from "@/lib/sync/freshness";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function isTrue(value: string | null): boolean {
  return value === "1" || value === "true";
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawDataset = searchParams.get("dataset");
  // An over-long id cannot exist; treat it as unknown instead of querying.
  const datasetId = rawDataset && rawDataset.length <= 300 ? rawDataset : undefined;
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
