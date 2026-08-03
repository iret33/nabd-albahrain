/*
  Warnings:

  - You are about to drop the `ScaffoldCheck` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "ScaffoldCheck";

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleClean" TEXT NOT NULL,
    "description" TEXT,
    "theme" TEXT,
    "publisher" TEXT,
    "recordsCount" INTEGER NOT NULL DEFAULT 0,
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "fieldsJson" JSONB NOT NULL,
    "statsJson" JSONB,
    "vizConfig" JSONB,
    "chartData" JSONB,
    "summaryAr" TEXT,
    "sourceModified" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "syncStatus" TEXT NOT NULL DEFAULT 'pending',
    "syncError" TEXT,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetRecord" (
    "id" BIGSERIAL NOT NULL,
    "datasetId" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "DatasetRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" SERIAL NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "processed" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "failuresJson" JSONB,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLock" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "running" BOOLEAN NOT NULL DEFAULT false,
    "since" TIMESTAMP(3),

    CONSTRAINT "SyncLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dataset_theme_idx" ON "Dataset"("theme");

-- CreateIndex
CREATE INDEX "Dataset_syncStatus_idx" ON "Dataset"("syncStatus");

-- CreateIndex
CREATE INDEX "DatasetRecord_datasetId_idx" ON "DatasetRecord"("datasetId");

-- AddForeignKey
ALTER TABLE "DatasetRecord" ADD CONSTRAINT "DatasetRecord_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
