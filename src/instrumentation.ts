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
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { assertProductionEnv } = await import("@/lib/env");
  assertProductionEnv();

  const { startScheduler } = await import("@/lib/sync/scheduler");
  startScheduler();
}
