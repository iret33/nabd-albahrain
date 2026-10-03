import type { Metadata } from "next";
import {
  countQuietPublicPresses,
  getAdminFreshness,
  getAdminStats,
  getAllDatasetsForAdmin,
  getRecentSyncLogs,
} from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/admin/require-admin";
import { getLockState } from "@/lib/sync/lock";
import { AdminDashboard } from "@/components/admin/admin-dashboard";
import { InsecureContextNotice } from "@/components/admin/insecure-context-notice";
import { adminCookieOptions } from "@/lib/admin-session";
import { logoutAction } from "./login/actions";

export const dynamic = "force-dynamic"; // always read current DB state, no caching
export const metadata: Metadata = {
  title: "لوحة الإدارة",
  robots: { index: false, follow: false },
};

interface Props {
  /** `?runs=all` turns the run history's "hide no-op public presses" filter off. */
  searchParams: Promise<{ runs?: string | string[] }>;
}

export default async function AdminPage({ searchParams }: Props) {
  // Middleware already guards /admin; verify again here so a middleware
  // bypass cannot expose the dashboard on its own.
  await requireAdmin();

  const { runs } = await searchParams;
  const showAllRuns = (Array.isArray(runs) ? runs[0] : runs) === "all";

  const [stats, freshness, datasets, logs, lock, hiddenRuns] = await Promise.all([
    getAdminStats(),
    getAdminFreshness(),
    getAllDatasetsForAdmin(),
    getRecentSyncLogs(20, { includeQuietPublic: showAllRuns }),
    getLockState(),
    countQuietPublicPresses(),
  ]);

  // Removed datasets' stale errors are not actionable; only live ones are retry candidates.
  const failures = datasets.filter((d) => d.syncStatus === "error" && !d.removedAt);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* A plain-http, non-loopback visit draws this page once from the just-set cookie the browser then drops. */}
      <InsecureContextNotice required={adminCookieOptions().secure} context="dashboard" />
      <div className="mb-4 flex justify-end">
        <form action={logoutAction}>
          <button type="submit" className="text-sm font-medium text-ink/50 transition-colors hover:text-coral">
            تسجيل الخروج
          </button>
        </form>
      </div>
      <AdminDashboard
        stats={stats}
        freshness={freshness}
        failures={failures}
        logs={logs}
        showAllRuns={showAllRuns}
        quietPublicPresses={hiddenRuns}
        datasets={datasets}
        initialLock={lock}
      />
    </div>
  );
}
