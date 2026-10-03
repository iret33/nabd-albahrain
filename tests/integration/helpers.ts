/**
 * Shared harness for the sync/API integration tests. They need a migrated
 * Postgres (DATABASE_URL) and are opt-in: RUN_INTEGRATION=1.
 *
 *   set -a; . ./.env.local; set +a
 *   RUN_INTEGRATION=1 pnpm test tests/integration
 *
 * WARNING: the tests TRUNCATE Dataset / SyncLog / SyncLock / SyncState (and so
 * DatasetRecord) of the database in DATABASE_URL. They refuse to run against a
 * database named exactly "nabd" (the production default) unless
 * INTEGRATION_ALLOW_WIPE=1.
 *
 * The test files in this folder all share one database, and vitest runs files
 * in parallel, so every file takes a cross-process mutex (a lock directory in
 * the OS temp dir) for its whole duration.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { startMockOds } from "../../scripts/mock-ods.mjs";

export const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";

type Mock = Awaited<ReturnType<typeof startMockOds>>;

export function databaseName(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (export your .env.local before running integration tests)");
  return new URL(url).pathname.replace(/^\//, "");
}

export function assertSafeDatabase(): void {
  const name = databaseName();
  if (name === "nabd" && process.env.INTEGRATION_ALLOW_WIPE !== "1") {
    throw new Error(
      'Refusing to wipe the database "nabd" (the production default). Point DATABASE_URL at a throwaway ' +
        "database or set INTEGRATION_ALLOW_WIPE=1.",
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cross-process mutex built on the atomicity of mkdir. Stale locks (>10 min) are broken. */
export async function acquireDbMutex(): Promise<() => void> {
  const dir = path.join(os.tmpdir(), `nabd-integration-${databaseName()}.lock`);
  const deadline = Date.now() + 5 * 60_000;
  while (true) {
    try {
      fs.mkdirSync(dir);
      return () => fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > 10 * 60_000) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* raced with the holder releasing it */
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the integration DB mutex");
      await sleep(100);
    }
  }
}

export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 10_000, intervalMs = 25, what = "condition" } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

export interface Harness {
  mock: Mock;
  prisma: typeof import("@/lib/prisma").prisma;
  engine: typeof import("@/lib/sync/engine");
  lock: typeof import("@/lib/sync/lock");
  log: typeof import("@/lib/sync/log");
  recompute: typeof import("@/lib/sync/recompute");
  scheduler: typeof import("@/lib/sync/scheduler");
  derived: typeof import("@/lib/sync/derived");
  /** Wipe the sync tables, restore the mock fixtures and the default env. */
  reset(): Promise<void>;
  /** A full baseline sync of the 10 mock datasets. */
  seed(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Start the in-process mock portal, point the engine at it and load the sync
 * modules (they read SYNC_* env at import, so the env is set first).
 */
export async function setupHarness(): Promise<Harness> {
  assertSafeDatabase();
  const release = await acquireDbMutex();
  try {
    // The engine logs every dataset; keep test output readable (DEBUG_INTEGRATION=1 shows it).
    if (process.env.DEBUG_INTEGRATION !== "1") {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
    }
    process.env.SYNC_DELAY_MS = "0";
    process.env.SYNC_RETRY_BASE_MS = "5";
    const mock: Mock = await startMockOds({ port: 0 });
    const odsBase = `${mock.url}/api/explore/v2.1`;
    process.env.ODS_BASE_URL = odsBase;

    const { prisma } = await import("@/lib/prisma");
    const engine = await import("@/lib/sync/engine");
    const lock = await import("@/lib/sync/lock");
    const log = await import("@/lib/sync/log");
    const recompute = await import("@/lib/sync/recompute");
    const scheduler = await import("@/lib/sync/scheduler");
    const derived = await import("@/lib/sync/derived");

    const harness: Harness = {
      mock,
      prisma,
      engine,
      lock,
      log,
      recompute,
      scheduler,
      derived,
      async reset() {
        process.env.ODS_BASE_URL = odsBase;
        // No real web server to notify unless a test opts in.
        delete process.env.SYNC_TOKEN;
        delete process.env.APP_INTERNAL_URL;
        mock.state.reset();
        await prisma.$executeRawUnsafe(
          'TRUNCATE TABLE "Dataset", "SyncLog", "SyncLock", "SyncState" RESTART IDENTITY CASCADE',
        );
        await prisma.$executeRawUnsafe('INSERT INTO "SyncLock" ("id", "running") VALUES (1, false)');
        await prisma.$executeRawUnsafe('INSERT INTO "SyncState" ("id") VALUES (1)');
      },
      async seed() {
        const result = await engine.runSync({ trigger: "test-seed" });
        if (result.status !== "success") throw new Error(`seed sync failed: ${result.error}`);
        mock.state.hits.export = 0;
        mock.state.hits.catalog = 0;
        mock.state.hits.catalogEntry = 0;
        mock.state.hits.total = 0;
        mock.state.hits.exportById = {};
      },
      async close() {
        try {
          vi.restoreAllMocks();
          await prisma.$disconnect();
          await mock.close();
        } finally {
          release();
        }
      },
    };
    return harness;
  } catch (err) {
    release();
    throw err;
  }
}
