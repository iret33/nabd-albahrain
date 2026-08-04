import type { Metadata } from "next";
import { getAdminStats, getAllDatasetsForAdmin, getRecentSyncLogs } from "@/lib/admin/queries";
import { getLockState } from "@/lib/sync/lock";
import { AdminDashboard } from "@/components/admin/admin-dashboard";
import { logoutAction } from "./login/actions";

export const dynamic = "force-dynamic"; // always read current DB state, no caching
export const metadata: Metadata = {
  title: "لوحة الإدارة | نبض البحرين",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  const [stats, datasets, logs, lock] = await Promise.all([
    getAdminStats(),
    getAllDatasetsForAdmin(),
    getRecentSyncLogs(20),
    getLockState(),
  ]);

  const failures = datasets.filter((d) => d.syncStatus === "error");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-4 flex justify-end">
        <form action={logoutAction}>
          <button type="submit" className="text-sm font-medium text-ink/50 transition-colors hover:text-coral">
            تسجيل الخروج
          </button>
        </form>
      </div>
      <AdminDashboard stats={stats} failures={failures} logs={logs} datasets={datasets} initialLock={lock} />
    </div>
  );
}
