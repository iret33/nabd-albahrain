/**
 * CLI entry point: `pnpm sync -- [--limit N] [--dataset <id>] [--force]`
 *
 * Thin wrapper around runSync() — all the real logic lives in engine.ts so
 * a later API route can call the exact same function.
 */

import { runSync } from "./engine";
import { SyncAlreadyRunningError } from "./lock";
import { prisma } from "@/lib/prisma";

function parseArgs(rawArgv: string[]) {
  // `pnpm sync -- --limit 10` and `pnpm run sync -- --limit 10` both forward
  // a literal leading "--" through to argv in some pnpm/npm versions —
  // strip stray separator tokens rather than erroring on them.
  const argv = rawArgv.filter((a) => a !== "--");

  let limit: number | undefined;
  let datasetId: string | undefined;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      const value = argv[++i];
      const n = Number(value);
      if (!value || !Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit requires a positive number, got ${JSON.stringify(value)}`);
      }
      limit = n;
    } else if (arg === "--dataset") {
      const value = argv[++i];
      if (!value) throw new Error("--dataset requires a dataset_id");
      datasetId = value;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: pnpm sync -- [--limit N] [--dataset <dataset_id>] [--force]\n\n" +
          "  --limit N        Only sync records for the first N datasets (catalog order).\n" +
          "  --dataset <id>   Only sync records for one specific dataset_id.\n" +
          "  --force          Re-fetch records even if the source is unchanged since the last sync.\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { limit, datasetId, force };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(
    `[sync-cli] Starting sync ${JSON.stringify(opts)}` +
      ` at ${new Date().toISOString()}`,
  );

  try {
    const result = await runSync({ ...opts, trigger: "cli" });

    console.log("\n[sync-cli] Summary:");
    console.log(`  processed: ${result.processed}`);
    console.log(`  succeeded: ${result.succeeded} (skipped/unchanged: ${result.skipped})`);
    console.log(`  failed:    ${result.failed}`);
    console.log(`  SyncLog id: ${result.syncLogId}`);
    if (result.failures.length > 0) {
      console.log("\n  Failures:");
      for (const f of result.failures) {
        console.log(`   - ${f.datasetId}: ${f.error}`);
      }
    }

    process.exitCode = result.failed > 0 && result.succeeded === 0 ? 1 : 0;
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

main();
