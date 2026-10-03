/**
 * Argument parsing for the sync CLI (kept separate from cli.ts, which runs
 * `main()` on import, so it can be unit-tested).
 */

export const USAGE =
  "Usage: pnpm sync -- [--limit N] [--dataset <dataset_id>] [--force] [--dry-run]\n" +
  "       pnpm sync -- --recompute [--dataset <dataset_id>] [--force]\n\n" +
  "  --limit N        Only sync records for the first N datasets (catalog order).\n" +
  "  --dataset <id>   Only sync records for one specific dataset_id.\n" +
  "  --force          Re-fetch records even if the source is unchanged since the last sync\n" +
  "                   (with --recompute: re-derive datasets that are already up to date).\n" +
  "  --dry-run        Check the catalog and print what WOULD change; writes and downloads nothing.\n" +
  "  --recompute      No network: re-derive stats/charts from the records already stored,\n" +
  "                   for datasets whose derived data is out of date. Partial (capped)\n" +
  "                   datasets are skipped; they need a forced sync.\n";

export interface CliOptions {
  limit?: number;
  datasetId?: string;
  force: boolean;
  dryRun: boolean;
  recompute: boolean;
  help: boolean;
}

export function parseArgs(rawArgv: string[]): CliOptions {
  // `pnpm sync -- --limit 10` and `pnpm run sync -- --limit 10` both forward
  // a literal leading "--" through to argv in some pnpm/npm versions —
  // strip stray separator tokens rather than erroring on them.
  const argv = rawArgv.filter((a) => a !== "--");

  const opts: CliOptions = { force: false, dryRun: false, recompute: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      const value = argv[++i];
      const n = Number(value);
      if (!value || !Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit requires a positive integer, got ${JSON.stringify(value)}`);
      }
      opts.limit = n;
    } else if (arg === "--dataset") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--dataset requires a dataset_id");
      opts.datasetId = value;
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--recompute") {
      opts.recompute = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (opts.recompute && (opts.dryRun || opts.limit !== undefined)) {
    throw new Error("--recompute cannot be combined with --dry-run or --limit");
  }
  return opts;
}
