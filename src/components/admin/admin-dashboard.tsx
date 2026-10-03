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
 *
 * Run status is shown from `SyncLog.status` (running / success / partial /
 * failed / aborted) with a red banner when the latest run failed — see
 * `src/lib/admin/sync-status.ts` for how legacy/crashed rows are classified.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { NumberLatin } from "@/components/number-latin";
import { formatDateTimeAr, formatNumber, formatRelativeAr } from "@/lib/format";
import type { AdminDatasetRow, AdminFreshness, AdminStats, AdminSyncLogRow } from "@/lib/admin/queries";
import {
  SYNC_RUN_STATUS_COLOR,
  SYNC_RUN_STATUS_LABEL,
  describeScope,
  describeTrigger,
  lastRunAlert,
  resolveSyncRunStatus,
  type SyncRunStatus,
} from "@/lib/admin/sync-status";
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

/** How long after a trigger an idle lock is still read as "not started yet" (the run takes the lock just after the 202). */
const START_GRACE_MS = 2500;
const POLL_INTERVAL_MS = 3000;

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

/**
 * A wall-clock snapshot that is `null` during SSR/hydration and then ticks
 * every 30s, so relative times ("منذ 5 دقائق") never cause a hydration
 * mismatch between the server render and the first client render.
 */
const NOW_TICK_MS = 30_000;
function subscribeNow(onTick: () => void) {
  const handle = setInterval(onTick, NOW_TICK_MS);
  return () => clearInterval(handle);
}
function snapshotNow(): number {
  return Math.floor(Date.now() / NOW_TICK_MS) * NOW_TICK_MS; // stable within a tick, as useSyncExternalStore requires
}
function useNow(): number | null {
  return useSyncExternalStore(subscribeNow, snapshotNow, () => null);
}

function FreshnessCard({ label, date, now }: { label: string; date: Date | null; now: number | null }) {
  return (
    <div className="rounded-2xl border border-line-light bg-white p-4">
      <p className="text-xs font-medium text-ink/50">{label}</p>
      {date ? (
        <>
          <p className="mt-1 text-sm font-semibold text-sea-900">{formatDateTimeAr(date)}</p>
          <p className="mt-0.5 min-h-4 text-xs text-ink/50">{now !== null ? formatRelativeAr(date, new Date(now)) : ""}</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-ink/40">لم يحدث بعد</p>
      )}
    </div>
  );
}

function RunStatusBadge({ status, raw }: { status: SyncRunStatus | null; raw: string }) {
  const color = status ? SYNC_RUN_STATUS_COLOR[status] : "#9aa3a6";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold"
      style={{ background: `${color}1f`, color }}
    >
      {status === "running" ? <Spinner small /> : <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {status ? SYNC_RUN_STATUS_LABEL[status] : raw}
    </span>
  );
}

function formatDuration(startedAt: Date, finishedAt: Date | null, running: boolean): string {
  if (!finishedAt) return running ? "قيد التنفيذ…" : "—";
  const ms = finishedAt.getTime() - startedAt.getTime();
  if (ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} ث`;
  return `${minutes} د ${seconds} ث`;
}

/** `GET /api/sync/status` after JSON serialization (Dates arrive as ISO strings). */
interface SyncStatusResponse {
  lock: { running: boolean; since: string | null; stale?: boolean };
  latestLog: { status?: string; processed?: number; total?: number } | null;
}

type PendingAction = { kind: "all" } | { kind: "recompute" } | { kind: "one"; id: string };

interface TriggerOptions {
  dataset?: string;
  force?: boolean;
  recompute?: boolean;
}

export function AdminDashboard({
  stats,
  freshness,
  failures,
  logs,
  datasets,
  initialLock,
}: {
  stats: AdminStats;
  freshness: AdminFreshness;
  failures: AdminDatasetRow[];
  logs: AdminSyncLogRow[];
  datasets: AdminDatasetRow[];
  initialLock: LockState;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const now = useNow();

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [lockRunning, setLockRunning] = useState(initialLock.running && !initialLock.stale);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [banner, setBanner] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [query, setQuery] = useState("");

  const pollHandleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleIgnoredUntilRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollHandleRef.current) {
      clearInterval(pollHandleRef.current);
      pollHandleRef.current = null;
    }
  }, []);

  const pollOnce = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status", { cache: "no-store" });
      if (res.status === 401) {
        // Session expired mid-run: nothing more this page can learn.
        stopPolling();
        setPending(null);
        setLockRunning(false);
        router.replace("/admin/login");
        return;
      }
      if (!res.ok) return;
      const data: SyncStatusResponse = await res.json();
      if (data.lock.running) {
        setLockRunning(true);
        const log = data.latestLog;
        setProgress(
          log && typeof log.processed === "number" && typeof log.total === "number" && log.total > 0
            ? { processed: log.processed, total: log.total }
            : null,
        );
        return;
      }
      // The run takes the lock a moment after the trigger's 202; do not
      // mistake that gap for "already finished".
      if (Date.now() < idleIgnoredUntilRef.current) return;
      stopPolling();
      setPending(null);
      setLockRunning(false);
      setProgress(null);
      startTransition(() => router.refresh());
    } catch {
      // Transient network hiccup — the next tick (still scheduled) retries.
    }
  }, [router, stopPolling, startTransition]);

  const ensurePolling = useCallback(() => {
    if (pollHandleRef.current) return;
    pollHandleRef.current = setInterval(pollOnce, POLL_INTERVAL_MS);
    void pollOnce();
  }, [pollOnce]);

  // If a sync is already running when the page first loads (e.g. started
  // from the CLI, the scheduler, or another admin tab), reflect that
  // immediately instead of waiting for a button click.
  useEffect(() => {
    if (initialLock.running && !initialLock.stale) {
      ensurePolling();
    }
    return stopPolling;
    // Mount-only bootstrap — intentionally not re-run when props change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trigger = useCallback(
    async (opts: TriggerOptions) => {
      setBanner(null);
      try {
        const params = new URLSearchParams();
        if (opts.dataset) params.set("dataset", opts.dataset);
        if (opts.force) params.set("force", "1");
        if (opts.recompute) params.set("recompute", "1");
        const qs = params.toString();

        const res = await fetch(`/api/sync${qs ? `?${qs}` : ""}`, {
          method: "POST",
          credentials: "same-origin",
        });

        if (res.status === 409) {
          setBanner({ kind: "info", text: "هناك مزامنة أخرى قيد التشغيل بالفعل — يعرض هذا حالتها." });
        } else if (res.status === 401) {
          setBanner({ kind: "error", text: "انتهت الجلسة. سجّل الدخول من جديد." });
          setPending(null);
          router.replace("/admin/login");
          return;
        } else if (res.status === 429) {
          setBanner({ kind: "error", text: "طلبات كثيرة خلال وقت قصير. انتظر قليلًا ثم حاول مرة أخرى." });
          setPending(null);
          return;
        } else if (!res.ok) {
          setBanner({ kind: "error", text: `تعذّر بدء المزامنة (رمز ${res.status}).` });
          setPending(null);
          return;
        }

        idleIgnoredUntilRef.current = Date.now() + START_GRACE_MS;
        setLockRunning(true);
        ensurePolling();
      } catch {
        setBanner({ kind: "error", text: "تعذّر الاتصال بخادم المزامنة." });
        setPending(null);
      }
    },
    [ensurePolling, router],
  );

  const busy = pending !== null || lockRunning;
  const isSyncingAll = pending?.kind === "all";
  const isRecomputing = pending?.kind === "recompute";
  const retryingId = pending?.kind === "one" ? pending.id : null;

  const handleSyncAll = () => {
    if (busy) return;
    setPending({ kind: "all" });
    void trigger({});
  };

  const handleRecompute = () => {
    if (busy) return;
    setPending({ kind: "recompute" });
    void trigger({ recompute: true });
  };

  const handleRetryOne = (datasetId: string) => {
    if (busy) return;
    setPending({ kind: "one", id: datasetId });
    void trigger({ dataset: datasetId, force: true });
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

  // The newest log row decides the "last run" banner; only it can be a live run.
  const lastSync = stats.lastSync;
  const lastStatus = lastSync ? resolveSyncRunStatus(lastSync, { isLatest: true, lockRunning }) : null;
  const alert = lastRunAlert(lastStatus);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-sea-900">لوحة الإدارة</h1>
          <p className="mt-1 text-sm text-ink/60">حالة المزامنة مع بوابة data.gov.bh ومجموعات البيانات المحلية.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleRecompute}
            disabled={busy}
            title="يعيد حساب الإحصاءات والمخططات من البيانات المخزّنة دون تنزيل جديد من البوابة"
            className="inline-flex items-center gap-2 rounded-lg border border-line-light bg-white px-4 py-2.5 font-display font-bold text-sea-900 transition-colors hover:border-pearl disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRecomputing && <Spinner />}
            {isRecomputing ? "جارٍ إعادة الحساب…" : "إعادة حساب المخططات"}
          </button>
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

      {/* The last run did not finish well: surface it before anything else. */}
      {alert && lastSync && (
        <div
          role="alert"
          data-testid="last-run-alert"
          className={`rounded-2xl border px-5 py-4 ${
            alert === "failed" ? "border-coral/40 bg-coral/10 text-coral" : "border-pearl/50 bg-pearl/15 text-sea-900"
          }`}
        >
          <p className="font-display text-base font-bold">
            {alert === "failed" ? "فشلت آخر عملية مزامنة" : "توقّفت آخر عملية مزامنة قبل اكتمالها"}
          </p>
          <p className="mt-1 text-xs opacity-80">
            بدأت في {formatDateTimeAr(lastSync.startedAt)} · {describeTrigger(lastSync.trigger)}
          </p>
          {lastSync.error ? (
            <p className="mt-2 break-words text-sm font-medium" dir="auto">
              {lastSync.error}
            </p>
          ) : (
            <p className="mt-2 text-sm opacity-80">لم يُسجَّل نص للخطأ.</p>
          )}
        </div>
      )}

      {/* Live progress while a run holds the lock. */}
      {lockRunning && (
        <div className="rounded-2xl border border-line-light bg-white px-5 py-4" role="status">
          <div className="flex items-center justify-between gap-3 text-sm font-medium text-sea-900">
            <span className="inline-flex items-center gap-2">
              <Spinner small />
              مزامنة قيد التنفيذ…
            </span>
            {progress && (
              // One LTR run, otherwise the RTL context swaps the two numbers ("10 / 3").
              <span dir="ltr" className="tabular-figures">
                {formatNumber(progress.processed)} / {formatNumber(progress.total)}
              </span>
            )}
          </div>
          {progress && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sand-100">
              <div
                className="h-full rounded-full bg-pearl"
                style={{ width: `${Math.min(100, Math.round((progress.processed / progress.total) * 100))}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Header stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="إجمالي المجموعات" value={stats.total} />
        <StatCard label="سليم" value={stats.ok} tone={STATUS_COLOR.ok} />
        <StatCard label="جزئي" value={stats.partial} tone={STATUS_COLOR.partial} />
        <StatCard label="خطأ" value={stats.error} tone={STATUS_COLOR.error} />
        <StatCard label="بالانتظار" value={stats.pending} tone={STATUS_COLOR.pending} />
        <StatCard label="محذوفة من البوابة" value={stats.removed} tone={stats.removed > 0 ? "#7b6a4d" : undefined} />
      </div>

      {/* Freshness (SyncState) + last run */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FreshnessCard label="آخر فحص للفهرس" date={freshness.lastCatalogCheckAt} now={now} />
        <FreshnessCard label="آخر مزامنة ناجحة" date={freshness.lastSuccessAt} now={now} />
        <FreshnessCard label="آخر تغيّر في البيانات" date={freshness.lastDataChangeAt} now={now} />
        <div className="rounded-2xl border border-line-light bg-white p-4">
          <p className="text-xs font-medium text-ink/50">آخر عملية مزامنة</p>
          {lastSync ? (
            <>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-sea-900">
                {formatDateTimeAr(lastSync.startedAt)}
                <RunStatusBadge status={lastStatus} raw={lastSync.status} />
              </p>
              <p className="mt-0.5 text-xs text-ink/50">
                المدة:{" "}
                <span dir="ltr" className="tabular-figures">
                  {formatDuration(lastSync.startedAt, lastSync.finishedAt, lastStatus === "running")}
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
            <table className="w-full min-w-[960px] text-start text-sm" data-testid="sync-log-table">
              <thead>
                <tr className="border-b border-line-light text-xs text-ink/50">
                  <th className="px-4 py-3 text-start font-medium">التاريخ</th>
                  <th className="px-4 py-3 text-start font-medium">الحالة</th>
                  <th className="px-4 py-3 text-start font-medium">المصدر</th>
                  <th className="px-4 py-3 text-start font-medium">المدة</th>
                  <th className="px-4 py-3 text-start font-medium">الإجمالي</th>
                  <th className="px-4 py-3 text-start font-medium">معالَجة</th>
                  <th className="px-4 py-3 text-start font-medium">محدَّثة</th>
                  <th className="px-4 py-3 text-start font-medium">متخطّاة</th>
                  <th className="px-4 py-3 text-start font-medium">فاشلة</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, index) => {
                  const status = resolveSyncRunStatus(log, { isLatest: index === 0, lockRunning });
                  const scope = describeScope(log.scope);
                  return (
                    <tr key={log.id} className="border-b border-line-light align-top last:border-0">
                      <td className="px-4 py-3 text-sea-900">{formatDateTimeAr(log.startedAt)}</td>
                      <td className="px-4 py-3">
                        <RunStatusBadge status={status} raw={log.status} />
                        {log.error && (
                          <p
                            className="mt-1.5 line-clamp-3 max-w-[22rem] break-words text-xs text-coral"
                            title={log.error}
                            dir="auto"
                          >
                            {log.error}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink/70">
                        {describeTrigger(log.trigger)}
                        {scope && <p className="mt-0.5 max-w-[14rem] truncate text-xs text-ink/40" title={scope}>{scope}</p>}
                      </td>
                      <td className="px-4 py-3 text-ink/70">
                        <span dir="ltr" className="tabular-figures">
                          {formatDuration(log.startedAt, log.finishedAt, status === "running")}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-ink/70">
                        <NumberLatin value={log.total} />
                      </td>
                      <td className="px-4 py-3">
                        <NumberLatin value={log.processed} />
                      </td>
                      <td className="px-4 py-3 text-[#3e8e7e]">
                        <NumberLatin value={log.updated} />
                      </td>
                      <td className="px-4 py-3 text-ink/70">
                        <NumberLatin value={log.skipped} />
                      </td>
                      <td className={log.failed > 0 ? "px-4 py-3 text-coral" : "px-4 py-3 text-ink/70"}>
                        <NumberLatin value={log.failed} />
                      </td>
                    </tr>
                  );
                })}
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
                      {d.removedAt && (
                        <span
                          className="mt-1 inline-block rounded-full bg-ink/10 px-2 py-0.5 text-[11px] font-medium text-ink/70"
                          title={`حُذفت من البوابة — ${formatDateTimeAr(d.removedAt)}`}
                        >
                          محذوفة من البوابة
                        </span>
                      )}
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
                        disabled={busy || !!d.removedAt}
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
