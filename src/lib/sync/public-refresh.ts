/**
 * Database-backed cooldowns for the public refresh button.
 *
 * The cooldown anchor is claimed with ONE conditional statement, so when many
 * visitors press the button at once exactly one wins and the rest get a 429:
 * there is no read-then-write window. Timestamps use `timezone('utc', now())`
 * inside the database (the columns are `timestamp(3)` without time zone), and
 * the remaining wait is computed by the database too, so the answer never
 * depends on the app server's clock or the session time zone.
 *
 * The cooldown is consumed even if the portal later fails: a down portal must
 * not be hammered by retries.
 */

import { prisma } from "@/lib/prisma";

export type CooldownClaim = { claimed: true } | { claimed: false; retryAfterSeconds: number };

/** Catalog-wide cooldown: SyncState.lastPublicRefreshAt. */
export async function claimCatalogCooldown(seconds: number): Promise<CooldownClaim> {
  const affected = await prisma.$executeRaw`
    INSERT INTO "SyncState" ("id", "lastPublicRefreshAt")
    VALUES (1, timezone('utc', now()))
    ON CONFLICT ("id") DO UPDATE SET "lastPublicRefreshAt" = timezone('utc', now())
    WHERE "SyncState"."lastPublicRefreshAt" IS NULL
       OR "SyncState"."lastPublicRefreshAt" < timezone('utc', now()) - make_interval(secs => ${seconds}::double precision)`;
  if (affected > 0) return { claimed: true };

  const rows = await prisma.$queryRaw<Array<{ secs: number }>>`
    SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
             "lastPublicRefreshAt" + make_interval(secs => ${seconds}::double precision) - timezone('utc', now())
           ))))::int AS "secs"
    FROM "SyncState" WHERE "id" = 1`;
  return { claimed: false, retryAfterSeconds: rows[0]?.secs ?? Math.max(1, seconds) };
}

/** Per-dataset cooldown: Dataset.refreshRequestedAt. The dataset must exist. */
export async function claimDatasetCooldown(datasetId: string, seconds: number): Promise<CooldownClaim> {
  const affected = await prisma.$executeRaw`
    UPDATE "Dataset"
    SET "refreshRequestedAt" = timezone('utc', now())
    WHERE "id" = ${datasetId}
      AND ("refreshRequestedAt" IS NULL
           OR "refreshRequestedAt" < timezone('utc', now()) - make_interval(secs => ${seconds}::double precision))`;
  if (affected > 0) return { claimed: true };

  const rows = await prisma.$queryRaw<Array<{ secs: number }>>`
    SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
             "refreshRequestedAt" + make_interval(secs => ${seconds}::double precision) - timezone('utc', now())
           ))))::int AS "secs"
    FROM "Dataset" WHERE "id" = ${datasetId}`;
  return { claimed: false, retryAfterSeconds: rows[0]?.secs ?? Math.max(1, seconds) };
}
