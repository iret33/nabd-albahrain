"use client";

/**
 * `/admin`'s interactive shell (Phase 6). The Server Component
 * (`src/app/admin/page.tsx`) does the initial data fetch straight from
 * Postgres (`src/lib/admin/queries.ts`, uncached — always current as of
 * page load); everything below is what needs live client-side state:
 * triggering syncs, polling `/api/sync/status` while one runs, and
 * filtering the dataset list.
 *
 * Data props (`stats`/`failures`/`logs`/`datasets`) are read directly in
 * JSX rather than copied into `useState` — that way `router.refresh()`
 * (called once a triggered sync's lock clears) re-renders this component
 * with genuinely fresh numbers from the server, instead of stale state
 * frozen at first mount. Local `useState` here is only for ephemeral UI
 * concerns: which trigger is in flight, the search box, and the status
 * banner.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { NumberLatin } from "@/components/number-latin";
import { formatDateTimeAr } from "@/lib/format";
import type { AdminStats, AdminDatasetRow, AdminSyncLogRow } from "@/lib/admin/queries";
import type { LockState } from "@/lib/sync/lock";

const STATUS_LABEL: Record<string, string> = {
  ok: "سليم",
  partial: "جزئي",
  error: "خطأ",
  pending: "بالانتظار",
};

const STATUS_COLOR: Record<string, string> = {
  ok: "#3e8e7e",
  partial: "#c9a961",
  error: "#a6473f",
  pending: "#9aa3a6",
};

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ background: STATUS_COLOR[status] ?? STATUS_COLOR.pending }}
      aria-hidden="true"
    />
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-2xl border border-line-light bg-white p-4">
      <p className="text-xs font-medium text-ink/50">{label}</p>
      <p className="font-display mt-1 text-2xl font-bold" style={tone ? { color: tone } : { color: "var(--sea-900)" }}>
        <NumberLatin value={value} />
      </p>
    </div>
  );
}

function formatDuration(startedAt: Date, finishedAt: Date | null): string {
  if (!finishedAt) return "قيد التنفيذ…";
  const ms = finishedAt.getTime() - startedAt.getTime();
  if (ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} ث`;
  return `${minutes} د ${seconds} ث`;
}

interface SyncStatusResponse {
  lock: LockState;
  latestLog: AdminSyncLogRow | null;
}

export function AdminDashboard({
  stats,
  failures,
  logs,
  datasets,
  initialLock,
}: {
  stats: AdminStats;
  failures: AdminDatasetRow[];
  logs: AdminSyncLogRow[];
  datasets: AdminDatasetRow[];
  initialLock: LockState;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [isSyncingAll, setIsSyncingAll] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [query, setQuery] = useState("");

  const pollHandleRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollHandleRef.current) {
      clearInterval(pollHandleRef.current);
      pollHandleRef.current = null;
    }
  }, []);

  const pollOnce = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status", { cache: "no-store" });
      if (!res.ok) return;
      const data: SyncStatusResponse = await res.json();
      if (!data.lock.running) {
        stopPolling();
        setIsSyncingAll(false);
        setRetryingId(null);
        startTransition(() => router.refresh());
      }
    } catch {
      // Transient network hiccup — the next tick (still scheduled) retries.
    }
  }, [router, stopPolling, startTransition]);

  const ensurePolling = useCallback(() => {
    if (pollHandleRef.current) return;
    pollHandleRef.current = setInterval(pollOnce, 3000);
    void pollOnce();
  }, [pollOnce]);

  // If a sync is already running when the page first loads (e.g. started
  // from the CLI, or another admin tab), reflect that immediately instead
  // of waiting for a button click.
  useEffect(() => {
    if (initialLock.running && !initialLock.stale) {
      setIsSyncingAll(true);
      ensurePolling();
    }
    return stopPolling;
    // Mount-only bootstrap — intentionally not re-run when props change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trigger = useCallback(
    async (datasetId?: string, force?: boolean) => {
      setBanner(null);
      try {
        const params = new URLSearchParams();
        if (datasetId) params.set("dataset", datasetId);
        if (force) params.set("force", "1");
        const qs = params.toString();

        const res = await fetch(`/api/sync${qs ? `?${qs}` : ""}`, {
          method: "POST",
          credentials: "same-origin",
        });

        if (res.status === 409) {
          setBanner({ kind: "info", text: "هناك مزامنة أخرى قيد التشغيل بالفعل — يعرض هذا حالتها." });
        } else if (!res.ok) {
          setBanner({ kind: "error", text: `تعذّر بدء المزامنة (رمز ${res.status}).` });
          setIsSyncingAll(false);
          setRetryingId(null);
          return;
        }

        ensurePolling();
      } catch {
        setBanner({ kind: "error", text: "تعذّر الاتصال بخادم المزامنة." });
        setIsSyncingAll(false);
        setRetryingId(null);
      }
    },
    [ensurePolling],
  );

  const busy = isSyncingAll || retryingId !== null;

  const handleSyncAll = () => {
    if (busy) return;
    setIsSyncingAll(true);
    void trigger(undefined, false);
  };

  const handleRetryOne = (datasetId: string) => {
    if (busy) return;
    setRetryingId(datasetId);
    void trigger(datasetId, true);
  };

  const filteredDatasets = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return datasets;
    return datasets.filter(
      (d) =>
        d.id.toLowerCase().includes(q) ||
        d.titleClean.toLowerCase().includes(q) ||
        (d.theme ?? "").toLowerCase().includes(q) ||
        (d.publisher ?? "").toLowerCase().includes(q),
    );
  })();

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-sea-900">لوحة الإدارة</h1>
          <p className="mt-1 text-sm text-ink/60">حالة المزامنة مع بوابة data.gov.bh ومجموعات البيانات المحلية.</p>
        </div>
        <button
          type="button"
          onClick={handleSyncAll}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg bg-sea-900 px-5 py-2.5 font-display font-bold text-white transition-colors hover:bg-sea-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSyncingAll && <Spinner />}
          {isSyncingAll ? "جارٍ التنفيذ…" : "مزامنة الكل الآن"}
        </button>
      </div>

      {banner && (
        <p
          role="status"
          className={`rounded-lg px-4 py-2.5 text-sm font-medium ${
            banner.kind === "error" ? "bg-coral/10 text-coral" : "bg-pearl/15 text-sea-900"
          }`}
        >
          {banner.text}
        </p>
      )}

      {/* Header stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="إجمالي المجموعات" value={stats.total} />
        <StatCard label="سليم" value={stats.ok} tone={STATUS_COLOR.ok} />
        <StatCard label="جزئي" value={stats.partial} tone={STATUS_COLOR.partial} />
        <StatCard label="خطأ" value={stats.error} tone={STATUS_COLOR.error} />
        <StatCard label="بالانتظار" value={stats.pending} tone={STATUS_COLOR.pending} />
        <div className="rounded-2xl border border-line-light bg-white p-4">
          <p className="text-xs font-medium text-ink/50">آخر مزامنة</p>
          {stats.lastSync ? (
            <>
              <p className="mt-1 text-sm font-semibold text-sea-900">{formatDateTimeAr(stats.lastSync.startedAt)}</p>
              <p className="mt-0.5 text-xs text-ink/50">
                المدة:{" "}
                <span dir="ltr" className="tabular-figures">
                  {formatDuration(stats.lastSync.startedAt, stats.lastSync.finishedAt)}
                </span>
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-ink/40">لا توجد مزامنة بعد</p>
          )}
        </div>
      </div>

      {/* Failures table */}
      <section>
        <h2 className="font-display text-lg font-bold text-sea-900">مجموعات فشلت مزامنتها</h2>
        {failures.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-line-light bg-white px-6 py-8 text-center text-sm text-ink/50">
            لا توجد أخطاء حالياً.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-line-light bg-white">
            <table className="w-full min-w-[640px] text-start text-sm">
              <thead>
                <tr className="border-b border-line-light text-xs text-ink/50">
                  <th className="px-4 py-3 text-start font-medium">المعرّف</th>
                  <th className="px-4 py-3 text-start font-medium">رسالة الخطأ</th>
                  <th className="px-4 py-3 text-start font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {failures.map((d) => (
                  <tr key={d.id} className="border-b border-line-light last:border-0">
                    <td className="max-w-[220px] truncate px-4 py-3 font-medium text-sea-900" title={d.id}>
                      {d.id}
                    </td>
                    <td className="max-w-[420px] truncate px-4 py-3 text-ink/70" title={d.syncError ?? ""}>
                      {d.syncError ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <button
                        type="button"
                        onClick={() => handleRetryOne(d.id)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line-light px-3 py-1.5 text-xs font-medium text-ink/80 transition-colors hover:border-coral hover:text-coral disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {retryingId === d.id && <Spinner small />}
                        إعادة المحاولة
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Last 20 SyncLog rows */}
      <section>
        <h2 className="font-display text-lg font-bold text-sea-900">سجل آخر عمليات المزامنة</h2>
        {logs.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-line-light bg-white px-6 py-8 text-center text-sm text-ink/50">
            لا يوجد سجل بعد.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-line-light bg-white">
            <table className="w-full min-w-[720px] text-start text-sm">
              <thead>
                <tr className="border-b border-line-light text-xs text-ink/50">
                  <th className="px-4 py-3 text-start font-medium">التاريخ</th>
                  <th className="px-4 py-3 text-start font-medium">المصدر</th>
                  <th className="px-4 py-3 text-start font-medium">المدة</th>
                  <th className="px-4 py-3 text-start font-medium">معالَجة</th>
                  <th className="px-4 py-3 text-start font-medium">ناجحة</th>
                  <th className="px-4 py-3 text-start font-medium">فاشلة</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-line-light last:border-0">
                    <td className="px-4 py-3 text-sea-900">{formatDateTimeAr(log.startedAt)}</td>
                    <td className="px-4 py-3 text-ink/70">{log.trigger}</td>
                    <td className="px-4 py-3 text-ink/70">
                      <span dir="ltr" className="tabular-figures">
                        {formatDuration(log.startedAt, log.finishedAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <NumberLatin value={log.processed} />
                    </td>
                    <td className="px-4 py-3 text-[#3e8e7e]">
                      <NumberLatin value={log.succeeded} />
                    </td>
                    <td className={log.failed > 0 ? "px-4 py-3 text-coral" : "px-4 py-3 text-ink/70"}>
                      <NumberLatin value={log.failed} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Full searchable dataset list */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-bold text-sea-900">كل مجموعات البيانات</h2>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث بالمعرّف أو العنوان أو الجهة…"
            className="w-full max-w-xs rounded-lg border border-line-light bg-white px-3.5 py-2 text-sm outline-none focus-visible:border-pearl"
          />
        </div>
        <p className="mt-2 text-xs text-ink/50">
          عرض <NumberLatin value={filteredDatasets.length} /> من <NumberLatin value={datasets.length} /> مجموعة
        </p>
        <div className="mt-3 max-h-[32rem] overflow-y-auto overflow-x-auto rounded-2xl border border-line-light bg-white">
          <table className="w-full min-w-[760px] text-start text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-line-light text-xs text-ink/50">
                <th className="px-4 py-3 text-start font-medium">الحالة</th>
                <th className="px-4 py-3 text-start font-medium">العنوان</th>
                <th className="px-4 py-3 text-start font-medium">الفئة</th>
                <th className="px-4 py-3 text-start font-medium">آخر مزامنة</th>
                <th className="px-4 py-3 text-start font-medium">السجلات</th>
                <th className="px-4 py-3 text-start font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {filteredDatasets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink/50">
                    لا توجد نتائج لبحثك — جرّب كلمة أخرى
                  </td>
                </tr>
              ) : (
                filteredDatasets.map((d) => (
                  <tr key={d.id} className="border-b border-line-light last:border-0">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2" title={STATUS_LABEL[d.syncStatus] ?? d.syncStatus}>
                        <StatusDot status={d.syncStatus} />
                        <span className="text-xs text-ink/50">{STATUS_LABEL[d.syncStatus] ?? d.syncStatus}</span>
                      </span>
                    </td>
                    <td className="max-w-[280px] px-4 py-3">
                      <p className="truncate font-medium text-sea-900" title={d.titleClean}>
                        {d.titleClean}
                      </p>
                      <p className="truncate text-xs text-ink/40" title={d.id}>
                        {d.id}
                      </p>
                    </td>
                    <td className="max-w-[160px] truncate px-4 py-3 text-ink/70">{d.theme ?? "—"}</td>
                    <td className="px-4 py-3 text-ink/70">
                      {d.lastSyncedAt ? formatDateTimeAr(d.lastSyncedAt) : "—"}
                    </td>
                    <td className="px-4 py-3 text-ink/70">
                      <NumberLatin value={d.sourceCount} />
                    </td>
                    <td className="px-4 py-3 text-end">
                      <button
                        type="button"
                        onClick={() => handleRetryOne(d.id)}
                        disabled={busy}
                        aria-label={`مزامنة ${d.titleClean}`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line-light px-3 py-1.5 text-xs font-medium text-ink/80 transition-colors hover:border-coral hover:text-coral disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {retryingId === d.id && <Spinner small />}
                        مزامنة
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Spinner({ small = false }: { small?: boolean }) {
  const size = small ? "h-3 w-3" : "h-4 w-4";
  return (
    <svg
      className={`${size} animate-spin motion-reduce:animate-none`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
