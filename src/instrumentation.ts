/**
 * Runs once when the Next.js server boots (Node runtime only).
 *
 * - validates the production environment (fails the boot loudly on a
 *   misconfiguration instead of limping along),
 * - starts the built-in sync scheduler (AUTO_SYNC_INTERVAL_MINUTES) and the
 *   boot-time cleanup of runs a previous process left "running".
 *
 * Skipped during `next build` (NEXT_PHASE=phase-production-build): the build
 * has no database and must not start timers.
 */
export async function register() {
  // The imports sit INSIDE the runtime check on purpose: Next compiles this
  // file for the Edge runtime too, and only a positive `=== "nodejs"` block
  // lets the bundler drop the Node-only code (Prisma, timers) from that build.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;

    const { assertProductionEnv } = await import("@/lib/env");
    try {
      assertProductionEnv();
    } catch (err) {
      // `next start` / `node server.js` would otherwise keep serving 500s for
      // every request (including /api/health). Exit so the supervisor
      // (Docker restart policy, systemd) surfaces the misconfiguration.
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }

    const { startScheduler } = await import("@/lib/sync/scheduler");
    startScheduler();
  }
}
