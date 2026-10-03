/**
 * Process-level bookkeeping for running syncs: a registry of in-flight runs
 * and SIGTERM/SIGINT handling.
 *
 * On a shutdown signal we ask every in-flight run to stop. The run then
 * finalizes its SyncLog row as "aborted" and releases its lock from its own
 * `finally` block (engine.ts), so the handler never writes to the database
 * itself.
 *
 * Two modes:
 *  - CLI (`exit: true`): wait (bounded) for the runs to wind down, then exit.
 *  - Web server (`exit: false`): Next installs its own SIGTERM handler that
 *    calls `process.exit(0)` without waiting for us, so releasing the lock
 *    here is strictly best-effort. The 30s heartbeat plus the 10-minute stale
 *    window (lock.ts) is the real crash-recovery guarantee.
 */

export interface ActiveRun {
  logId: number;
  /** Ask the run to stop at its next checkpoint (aborts in-flight requests). */
  abort(reason: string): void;
  /** Settles when the run has finalized its log row and released its lock. */
  done: Promise<unknown>;
}

const g = globalThis as unknown as {
  __nabdActiveRuns?: Set<ActiveRun>;
  __nabdShutdownInstalled?: boolean;
};

function registry(): Set<ActiveRun> {
  return (g.__nabdActiveRuns ??= new Set<ActiveRun>());
}

/** Register an in-flight run; returns the function that unregisters it. */
export function registerActiveRun(run: ActiveRun): () => void {
  registry().add(run);
  return () => {
    registry().delete(run);
  };
}

export function activeRunCount(): number {
  return registry().size;
}

/** Abort every in-flight run and wait (at most `graceMs`) for them to finish. */
export async function abortActiveRuns(reason: string, graceMs = 5_000): Promise<number> {
  const runs = [...registry()];
  for (const run of runs) run.abort(reason);
  if (runs.length === 0) return 0;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
    timer.unref?.();
  });
  await Promise.race([Promise.allSettled(runs.map((r) => r.done)).then(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
  return runs.length;
}

/**
 * Install SIGTERM/SIGINT handlers once per process.
 *
 * `exit: true` is for the CLI: the process exits once the runs have wound
 * down (or after `graceMs`), and a second signal exits immediately.
 */
export function installShutdownHandlers(opts: { exit: boolean; graceMs?: number }): void {
  if (g.__nabdShutdownInstalled) return;
  g.__nabdShutdownInstalled = true;
  const graceMs = opts.graceMs ?? 10_000;
  let signalled = false;

  const handler = (signal: NodeJS.Signals) => {
    const code = signal === "SIGINT" ? 130 : 143;
    if (signalled) {
      if (opts.exit) process.exit(code);
      return;
    }
    signalled = true;
    console.warn(`[sync] Received ${signal}; stopping the running sync and releasing the lock...`);
    void abortActiveRuns(`Stopped by ${signal}`, graceMs)
      .catch((err) => console.error("[sync] Error while stopping runs:", err))
      .finally(() => {
        if (opts.exit) process.exit(code);
      });
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
