/**
 * Database-backed cooldowns for the public refresh button.
 *
 * The cooldown anchor is claimed under a row lock (`SELECT ... FOR UPDATE`,
 * then one conditional UPDATE, in one short transaction), so when many
 * visitors press the button at once exactly one wins and the rest get a 429:
 * there is no read-then-write window. Timestamps use
 * `timezone('utc', clock_timestamp())` inside the database (the columns are
 * `timestamp(3)` without time zone), and the remaining wait is computed by the
 * database too, so the answer never depends on the app server's clock or the
 * session time zone.
 *
 * The cooldown is consumed even if the portal later fails: a down portal must
 * not be hammered by retries. The one thing that is given back is a claim that
 * ended in "a run was already in progress": nothing was checked for the
 * visitor, so it must not cost them ten minutes. `release()` restores the
 * previous anchor, but only while the anchor still holds OUR claim (a
 * compare-and-set), so it can never wipe a later legitimate claim.
 */

import { prisma } from "@/lib/prisma";

export type CooldownClaim =
  | {
      claimed: true;
      /**
       * Give the claim back (restore the previous anchor) if nobody claimed
       * again since. Never throws: a failure is logged and the cooldown then
       * simply runs out on its own.
       */
      release(): Promise<void>;
    }
  | { claimed: false; retryAfterSeconds: number };

interface ClaimRow {
  /** The anchor as text in the database's own representation, null when unset. */
  prev: string | null;
  free: boolean;
  secs: number | null;
}

/**
 * Anchors travel as text produced by the database (`to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.US')`)
 * and are cast back by the database, never through a JS Date: the columns are
 * timestamp(3) without a time zone, and a Date bound as a parameter would be
 * compared in the session time zone.
 */
function makeRelease(
  restore: (prev: string | null, claimed: string) => Promise<number>,
  prev: string | null,
  claimed: string,
  what: string,
): () => Promise<void> {
  return async () => {
    try {
      await restore(prev, claimed);
    } catch (err) {
      console.error(`[public-refresh] Could not give back the ${what} cooldown:`, err);
    }
  };
}

/** A cooldown that is still running, read WITHOUT claiming anything. */
export type CooldownPeek = { active: false } | { active: true; retryAfterSeconds: number };

/**
 * Is the catalog cooldown running? Read-only (no lock, no write): the route
 * answers "cooldown" from this BEFORE it looks at the sync lock, so a press
 * inside a cooldown is told so even while a run is in flight, and a press that
 * will end in "already running" never touches the anchor at all.
 */
export async function peekCatalogCooldown(seconds: number): Promise<CooldownPeek> {
  const rows = await prisma.$queryRaw<ClaimRow[]>`
    SELECT NULL::text AS "prev",
           ("lastPublicRefreshAt" IS NULL
             OR "lastPublicRefreshAt" < timezone('utc', clock_timestamp()) - make_interval(secs => ${seconds}::double precision)) AS "free",
           GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
             "lastPublicRefreshAt" + make_interval(secs => ${seconds}::double precision) - timezone('utc', clock_timestamp())
           ))))::int AS "secs"
    FROM "SyncState" WHERE "id" = 1`;
  const row = rows[0];
  return !row || row.free ? { active: false } : { active: true, retryAfterSeconds: row.secs ?? Math.max(1, seconds) };
}

/** The same for one dataset's cooldown (an unknown dataset reads as "not running"). */
export async function peekDatasetCooldown(datasetId: string, seconds: number): Promise<CooldownPeek> {
  const rows = await prisma.$queryRaw<ClaimRow[]>`
    SELECT NULL::text AS "prev",
           ("refreshRequestedAt" IS NULL
             OR "refreshRequestedAt" < timezone('utc', clock_timestamp()) - make_interval(secs => ${seconds}::double precision)) AS "free",
           GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
             "refreshRequestedAt" + make_interval(secs => ${seconds}::double precision) - timezone('utc', clock_timestamp())
           ))))::int AS "secs"
    FROM "Dataset" WHERE "id" = ${datasetId}`;
  const row = rows[0];
  return !row || row.free ? { active: false } : { active: true, retryAfterSeconds: row.secs ?? Math.max(1, seconds) };
}

/** Catalog-wide cooldown: SyncState.lastPublicRefreshAt. */
export async function claimCatalogCooldown(seconds: number): Promise<CooldownClaim> {
  const outcome = await prisma.$transaction(async (tx) => {
    // The singleton row normally exists (migration seed); create it if not.
    await tx.$executeRaw`INSERT INTO "SyncState" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING`;
    const rows = await tx.$queryRaw<ClaimRow[]>`
      SELECT to_char("lastPublicRefreshAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "prev",
             ("lastPublicRefreshAt" IS NULL
               OR "lastPublicRefreshAt" < timezone('utc', clock_timestamp()) - make_interval(secs => ${seconds}::double precision)) AS "free",
             GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
               "lastPublicRefreshAt" + make_interval(secs => ${seconds}::double precision) - timezone('utc', clock_timestamp())
             ))))::int AS "secs"
      FROM "SyncState" WHERE "id" = 1 FOR UPDATE`;
    const row = rows[0];
    if (!row?.free) return { claimed: false as const, retryAfterSeconds: row?.secs ?? Math.max(1, seconds) };
    const claimed = await tx.$queryRaw<Array<{ claimed: string }>>`
      UPDATE "SyncState" SET "lastPublicRefreshAt" = timezone('utc', clock_timestamp()) WHERE "id" = 1
      RETURNING to_char("lastPublicRefreshAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "claimed"`;
    return { claimed: true as const, prev: row.prev, at: claimed[0].claimed };
  });
  if (!outcome.claimed) return outcome;
  return {
    claimed: true,
    release: makeRelease(
      (prev, at) => prisma.$executeRaw`
        UPDATE "SyncState" SET "lastPublicRefreshAt" = ${prev}::timestamp
        WHERE "id" = 1 AND to_char("lastPublicRefreshAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') = ${at}`,
      outcome.prev,
      outcome.at,
      "catalog",
    ),
  };
}

/** Per-dataset cooldown: Dataset.refreshRequestedAt. The dataset must exist. */
export async function claimDatasetCooldown(datasetId: string, seconds: number): Promise<CooldownClaim> {
  const outcome = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimRow[]>`
      SELECT to_char("refreshRequestedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "prev",
             ("refreshRequestedAt" IS NULL
               OR "refreshRequestedAt" < timezone('utc', clock_timestamp()) - make_interval(secs => ${seconds}::double precision)) AS "free",
             GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
               "refreshRequestedAt" + make_interval(secs => ${seconds}::double precision) - timezone('utc', clock_timestamp())
             ))))::int AS "secs"
      FROM "Dataset" WHERE "id" = ${datasetId} FOR UPDATE`;
    const row = rows[0];
    if (!row?.free) return { claimed: false as const, retryAfterSeconds: row?.secs ?? Math.max(1, seconds) };
    const claimed = await tx.$queryRaw<Array<{ claimed: string }>>`
      UPDATE "Dataset" SET "refreshRequestedAt" = timezone('utc', clock_timestamp()) WHERE "id" = ${datasetId}
      RETURNING to_char("refreshRequestedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "claimed"`;
    return { claimed: true as const, prev: row.prev, at: claimed[0].claimed };
  });
  if (!outcome.claimed) return outcome;
  return {
    claimed: true,
    release: makeRelease(
      (prev, at) => prisma.$executeRaw`
        UPDATE "Dataset" SET "refreshRequestedAt" = ${prev}::timestamp
        WHERE "id" = ${datasetId} AND to_char("refreshRequestedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') = ${at}`,
      outcome.prev,
      outcome.at,
      "dataset",
    ),
  };
}
