/**
 * CLI entry point:
 *   pnpm sync -- [--limit N] [--dataset <id>] [--force] [--dry-run]
 *   pnpm sync -- --recompute [--dataset <id>] [--force]
 *
 * Thin wrapper around runSync()/runRecompute() — all the real logic lives in
 * engine.ts / recompute.ts so the API routes and the scheduler call the exact
 * same functions. Also runs from the production image as the bundled
 * `dist/sync-cli.cjs` (`pnpm build:cli`).
 *
 * SIGTERM/SIGINT stop the run gracefully: the SyncLog row is finalized as
 * "aborted" and the lock released before the process exits.
 */

import "./load-env"; // must stay first: the imports below read the environment as they load
import { parseArgs, USAGE, type CliOptions } from "./cli-args";
import { runSync } from "./engine";
import { SyncAlreadyRunningError } from "./lock";
import { runRecompute } from "./recompute";
import { installShutdownHandlers } from "./runtime";
import { prisma } from "@/lib/prisma";

function printList(label: string, ids: string[]) {
  if (ids.length === 0) return;
  const shown = ids.slice(0, 50).join(", ");
  console.log(`  ${label} (${ids.length}): ${shown}${ids.length > 50 ? ", ..." : ""}`);
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[sync-cli] ${err instanceof Error ? err.message : String(err)}\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  installShutdownHandlers({ exit: true });

  console.log(`[sync-cli] Starting ${JSON.stringify(opts)} at ${new Date().toISOString()}`);

  try {
    if (opts.recompute) {
      const result = await runRecompute({ trigger: "cli", datasetId: opts.datasetId, force: opts.force });
      console.log("\n[sync-cli] Recompute summary:");
      console.log(`  status:    ${result.status}${result.error ? ` (${result.error})` : ""}`);
      console.log(`  processed: ${result.processed}`);
      console.log(`  updated:   ${result.updated}`);
      console.log(`  failed:    ${result.failed}`);
      printList("skipped (partial, need a forced sync)", result.skippedPartial);
      console.log(`  SyncLog id: ${result.syncLogId}`);
      for (const f of result.failures) console.log(`   - ${f.datasetId}: ${f.error}`);
      process.exitCode = result.status === "failed" || result.status === "aborted" ? 1 : 0;
      return;
    }

    const result = await runSync({
      limit: opts.limit,
      datasetId: opts.datasetId,
      force: opts.force,
      dryRun: opts.dryRun,
      trigger: "cli",
    });

    if (result.dryRun) {
      console.log("\n[sync-cli] Dry run (nothing was written or downloaded):");
      console.log(`  unchanged: ${result.skipped}`);
      printList("would re-download", result.changed.updated);
      printList("would defer", result.changed.deferred);
      printList("new datasets", result.changed.added);
      printList("would be flagged removed", result.changed.removed);
      printList("malformed catalog entries", result.failures.map((f) => f.datasetId));
      return;
    }

    console.log("\n[sync-cli] Summary:");
    console.log(`  status:    ${result.status}${result.error ? ` (${result.error})` : ""}`);
    console.log(`  processed: ${result.processed}`);
    console.log(`  updated:   ${result.updated}`);
    console.log(`  succeeded: ${result.succeeded} (skipped/unchanged: ${result.skipped})`);
    console.log(`  failed:    ${result.failed}`);
    console.log(`  added: ${result.added}  removed: ${result.removed}  deferred: ${result.deferred}`);
    console.log(`  SyncLog id: ${result.syncLogId}`);
    if (result.failures.length > 0) {
      console.log("\n  Failures:");
      for (const f of result.failures) {
        console.log(`   - ${f.datasetId}: ${f.error}`);
      }
    }

    // A partial run exits 0 (most datasets are fine and the failures are in
    // the summary/SyncLog); a failed or aborted run exits 1.
    process.exitCode = result.status === "failed" || result.status === "aborted" ? 1 : 0;
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) {
      console.error(`[sync-cli] ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.error("[sync-cli] Sync crashed:", err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
