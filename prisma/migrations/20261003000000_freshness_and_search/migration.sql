-- NOTE: Prisma's diff wants to drop the hand-authored pg_trgm GIN indexes
-- (it cannot model gin_trgm_ops). They are intentionally KEPT.

-- DropIndex
DROP INDEX "DatasetRecord_datasetId_idx";

-- AlterTable
ALTER TABLE "Dataset" ADD COLUMN     "derivedVersion" INTEGER,
ADD COLUMN     "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "license" TEXT,
ADD COLUMN     "refreshRequestedAt" TIMESTAMP(3),
ADD COLUMN     "removedAt" TIMESTAMP(3),
ADD COLUMN     "searchText" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "syncedVersion" TEXT,
ADD COLUMN     "titleAr" TEXT;

-- AlterTable
ALTER TABLE "SyncLock" ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "holder" TEXT;

-- AlterTable
ALTER TABLE "SyncLog" ADD COLUMN     "changedJson" JSONB,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "scope" TEXT,
ADD COLUMN     "skipped" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'running',
ADD COLUMN     "total" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updated" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SyncState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastCatalogCheckAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastDataChangeAt" TIMESTAMP(3),
    "lastPublicRefreshAt" TIMESTAMP(3),

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dataset_removedAt_idx" ON "Dataset"("removedAt");

-- CreateIndex
CREATE INDEX "Dataset_publisher_idx" ON "Dataset"("publisher");

-- CreateIndex
CREATE INDEX "Dataset_sourceModified_idx" ON "Dataset"("sourceModified");

-- CreateIndex
CREATE INDEX "DatasetRecord_datasetId_id_idx" ON "DatasetRecord"("datasetId", "id");

-- ---------------------------------------------------------------------------
-- Hand-authored additions (not expressible in schema.prisma)
-- ---------------------------------------------------------------------------

-- Trigram index over the normalized, concatenated search text.
CREATE INDEX IF NOT EXISTS "Dataset_searchText_trgm_idx"
  ON "Dataset" USING gin ("searchText" gin_trgm_ops);

-- Legacy SyncLog rows predate the status column: classify them from their
-- counters so the admin UI does not show every historical run as "running".
UPDATE "SyncLog" SET
  "status" = CASE
    WHEN "finishedAt" IS NULL THEN 'aborted'
    WHEN "failed" > 0 AND "succeeded" > 0 THEN 'partial'
    WHEN "failed" > 0 THEN 'failed'
    ELSE 'success'
  END,
  "total" = "processed",
  "updated" = "succeeded";

-- A lock left running by the previous (heartbeat-less) code must remain
-- acquirable once stale: give it a heartbeat equal to its start time.
UPDATE "SyncLock" SET "heartbeatAt" = "since" WHERE "running" = true;

-- Singleton rows.
INSERT INTO "SyncLock" ("id", "running") VALUES (1, false) ON CONFLICT ("id") DO NOTHING;
INSERT INTO "SyncState" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

-- Seed lastSuccessAt/lastCatalogCheckAt from history so the UI has a
-- freshness timestamp immediately after deploy.
UPDATE "SyncState" SET
  "lastCatalogCheckAt" = (SELECT max("finishedAt") FROM "SyncLog" WHERE "status" IN ('success', 'partial')),
  "lastSuccessAt"      = (SELECT max("finishedAt") FROM "SyncLog" WHERE "status" IN ('success', 'partial')),
  "lastDataChangeAt"   = (SELECT max("lastSyncedAt") FROM "Dataset")
WHERE "id" = 1;
