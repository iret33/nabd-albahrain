/**
 * POST /api/refresh — PUBLIC "check for new data" button (no token).
 *
 *   {"scope":"catalog"}                       look for changed datasets
 *   {"scope":"dataset","id":"<dataset_id>"}   refresh this one dataset
 *
 * Abuse resistance, in the order the checks run:
 *   1. kill switch        PUBLIC_REFRESH_ENABLED=0           -> 503 disabled
 *   2. cross-origin guard Origin host must match Host / site -> 403 bad_origin
 *   3. strict body        unknown keys (incl. `force`)       -> 400 bad_request
 *   4. per-client limit   20 POSTs/hour (clientKey())        -> 429 rate_limited
 *   5. dataset scope      id must exist and not be removed   -> 404 unknown_dataset
 *   6. DB cooldown        one atomic UPDATE shared by all
 *                         visitors (catalog 120s, dataset
 *                         600s), consumed even if the portal
 *                         later fails                        -> 429 cooldown
 *   7. stampede collapse  catalog checked < 60s ago          -> 200 up_to_date
 *   8. start              never forced, never a full
 *                         re-download of a large dataset     -> 202 started /
 *                                                               already_running
 * Every body is JSON `{ status, ... }`. The work itself runs in the
 * background with the sync lock already held (see startSyncInBackground), so
 * "started" and "already_running" are truthful.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { readTextCapped } from "@/lib/sync/body";
import { loadPublicRefreshConfig } from "@/lib/sync/config";
import { startSyncInBackground } from "@/lib/sync/engine";
import { claimCatalogCooldown, claimDatasetCooldown } from "@/lib/sync/public-refresh";
import { isAllowedOrigin, MAX_REFRESH_BODY_BYTES, parseRefreshBody } from "@/lib/sync/refresh-policy";

export const dynamic = "force-dynamic";

const CLIENT_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 } as const;
/** A catalog pass younger than this answers "up to date" without touching the portal. */
const UP_TO_DATE_MS = 60_000;

function respond(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export async function POST(req: NextRequest) {
  const cfg = loadPublicRefreshConfig();
  if (!cfg.enabled) return respond({ status: "disabled" }, 503);

  if (!isAllowedOrigin(req.headers.get("origin"), req.headers.get("host"), process.env.NEXT_PUBLIC_SITE_URL)) {
    return respond({ status: "bad_origin" }, 403);
  }

  const text = await readTextCapped(req, MAX_REFRESH_BODY_BYTES);
  const parsed = text === null ? { ok: false as const } : parseRefreshBody(text);
  if (!parsed.ok) return respond({ status: "bad_request" }, 400);
  const body = parsed.body;

  const limited = rateLimit(`refresh:${clientKey(req.headers)}`, CLIENT_LIMIT);
  if (!limited.ok) {
    return respond(
      { status: "rate_limited", retryAfterSeconds: limited.retryAfterSeconds },
      429,
      { "Retry-After": String(limited.retryAfterSeconds) },
    );
  }

  try {
    if (body.scope === "dataset") {
      const exists = await prisma.dataset.findFirst({
        where: { id: body.id, removedAt: null },
        select: { id: true },
      });
      if (!exists) return respond({ status: "unknown_dataset" }, 404);
    }

    const claim =
      body.scope === "catalog"
        ? await claimCatalogCooldown(cfg.catalogCooldownSeconds)
        : await claimDatasetCooldown(body.id, cfg.datasetCooldownSeconds);
    if (!claim.claimed) {
      return respond(
        { status: "cooldown", scope: body.scope, retryAfterSeconds: claim.retryAfterSeconds },
        429,
        { "Retry-After": String(claim.retryAfterSeconds) },
      );
    }

    if (body.scope === "catalog") {
      const state = await prisma.syncState.findUnique({
        where: { id: 1 },
        select: { lastCatalogCheckAt: true },
      });
      const checked = state?.lastCatalogCheckAt;
      if (checked && Date.now() - checked.getTime() < UP_TO_DATE_MS) {
        return respond({ status: "up_to_date", checkedAt: checked.toISOString() }, 200);
      }
    }

    const started = await startSyncInBackground({
      trigger: "public",
      datasetId: body.scope === "dataset" ? body.id : undefined,
      maxRecords: cfg.maxRecords,
      maxDatasets: cfg.maxDatasets,
    });
    if (!started.started) {
      return respond({ status: "already_running", since: started.since.toISOString(), scope: body.scope }, 202);
    }
    return respond({ status: "started", runId: started.runId, scope: body.scope }, 202);
  } catch (err) {
    console.error("[api/refresh] failed:", err);
    return respond({ status: "error" }, 500);
  }
}
