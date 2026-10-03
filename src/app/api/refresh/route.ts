/**
 * POST /api/refresh — PUBLIC "check for new data" button (no token).
 *
 *   {"scope":"catalog"}                       look for changed datasets
 *   {"scope":"dataset","id":"<dataset_id>"}   refresh this one dataset
 *
 * Abuse resistance, in the order the checks run:
 *   1. kill switch        PUBLIC_REFRESH_ENABLED off          -> 503 disabled
 *   2. cross-origin guard Origin host must match Host / site -> 403 bad_origin
 *   3. strict body        unknown keys (incl. `force`), a
 *                         malformed dataset id (NUL byte,
 *                         lone surrogate, > 200 chars)        -> 400 bad_request
 *   4. per-client limits  two in-memory buckets per
 *                         clientKey(): every accepted POST
 *                         counts against a generous
 *                         "attempts" bucket (120/hour: stops
 *                         hammering the cooldown UPDATE), and
 *                         only presses that really STARTED a
 *                         run count against the "runs" bucket
 *                         (20/hour). cooldown, up_to_date and
 *                         already_running answers cost the
 *                         visitor nothing but an attempt      -> 429 rate_limited
 *   5. dataset scope      id must exist and not be removed   -> 404 unknown_dataset
 *   6. cooldown running   read-only peek (catalog 120s, dataset
 *                         600s, shared by all visitors)       -> 429 cooldown
 *   7. run in progress    read-only peek at the global lock;
 *                         touches no cooldown                 -> 202 already_running
 *   8. DB cooldown        one atomic claim under a row lock;
 *                         consumed even if the portal later
 *                         fails (a down portal is not hammered)
 *                                                             -> 429 cooldown (lost the race)
 *   9. stampede collapse  catalog checked < 60s ago           -> 200 up_to_date
 *                         (the cooldown stays consumed, on purpose)
 *  10. start              never forced, never a full
 *                         re-download of a large dataset      -> 202 started
 *                         If the lock was taken between 7 and 10 the claim is
 *                         given back (compare-and-set), so a press that checked
 *                         nothing does not cost ten minutes
 *                                                             -> 202 already_running
 * Every body is JSON `{ status, ... }`. The work itself runs in the
 * background with the sync lock already held (see startSyncInBackground), so
 * "started" and "already_running" are truthful. `already_running` carries the
 * scope of the run that is in progress (`runScope`), because it is NOT
 * necessarily a run that covers what the visitor asked for.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clientKey, peekRateLimit, rateLimit } from "@/lib/rate-limit";
import { readTextCapped } from "@/lib/sync/body";
import { loadPublicRefreshConfig } from "@/lib/sync/config";
import { startSyncInBackground } from "@/lib/sync/engine";
import { clearFreshnessMemo, getRunningScope } from "@/lib/sync/freshness";
import { getLockState } from "@/lib/sync/lock";
import {
  claimCatalogCooldown,
  claimDatasetCooldown,
  peekCatalogCooldown,
  peekDatasetCooldown,
} from "@/lib/sync/public-refresh";
import { isAllowedOrigin, MAX_REFRESH_BODY_BYTES, parseRefreshBody } from "@/lib/sync/refresh-policy";

export const dynamic = "force-dynamic";

/** Presses that actually started a run, per client per hour. */
const RUNS_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 } as const;
/** Every accepted POST (also the ones answered cooldown / up_to_date / already_running), per client per hour. */
const ATTEMPTS_LIMIT = { limit: 120, windowMs: 60 * 60 * 1000 } as const;
/** A catalog pass younger than this answers "up to date" without touching the portal. */
const UP_TO_DATE_MS = 60_000;

function respond(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function rateLimited(retryAfterSeconds: number) {
  return respond({ status: "rate_limited", retryAfterSeconds }, 429, { "Retry-After": String(retryAfterSeconds) });
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

  const client = clientKey(req.headers);
  const attempt = rateLimit(`refresh-attempts:${client}`, ATTEMPTS_LIMIT);
  if (!attempt.ok) return rateLimited(attempt.retryAfterSeconds);
  const runsKey = `refresh:${client}`;
  const runs = peekRateLimit(runsKey, RUNS_LIMIT);
  if (!runs.ok) return rateLimited(runs.retryAfterSeconds);

  try {
    if (body.scope === "dataset") {
      const exists = await prisma.dataset.findFirst({
        where: { id: body.id, removedAt: null },
        select: { id: true },
      });
      if (!exists) return respond({ status: "unknown_dataset" }, 404);
    }

    const cooldownResponse = (retryAfterSeconds: number) =>
      respond({ status: "cooldown", scope: body.scope, retryAfterSeconds }, 429, {
        "Retry-After": String(retryAfterSeconds),
      });

    // Read-only first: a press inside a running cooldown is told so even while
    // a run is in flight (the cooldown is the more useful answer), and the
    // already-running branch below then never has to write anything.
    const cooling =
      body.scope === "catalog"
        ? await peekCatalogCooldown(cfg.catalogCooldownSeconds)
        : await peekDatasetCooldown(body.id, cfg.datasetCooldownSeconds);
    if (cooling.active) return cooldownResponse(cooling.retryAfterSeconds);

    // While ANY run holds the global lock nothing can start, so do not touch
    // (and so do not burn) the visitor's cooldown.
    const lock = await getLockState();
    if (lock.running && !lock.stale) {
      return respond(
        { status: "already_running", since: lock.since?.toISOString() ?? null, scope: body.scope, runScope: await getRunningScope() },
        202,
      );
    }

    const claim =
      body.scope === "catalog"
        ? await claimCatalogCooldown(cfg.catalogCooldownSeconds)
        : await claimDatasetCooldown(body.id, cfg.datasetCooldownSeconds);
    if (!claim.claimed) return cooldownResponse(claim.retryAfterSeconds);
    // The cooldown just moved: a cached freshness snapshot would hide the countdown.
    clearFreshnessMemo();

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
      // Somebody took the lock between the peek and now: nothing was checked
      // for this visitor, so give the cooldown back instead of burning it.
      await claim.release();
      clearFreshnessMemo();
      return respond(
        { status: "already_running", since: started.since.toISOString(), scope: body.scope, runScope: await getRunningScope() },
        202,
      );
    }
    rateLimit(runsKey, RUNS_LIMIT);
    return respond({ status: "started", runId: started.runId, scope: body.scope }, 202);
  } catch (err) {
    console.error("[api/refresh] failed:", err);
    return respond({ status: "error" }, 500);
  }
}
