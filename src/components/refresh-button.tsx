"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { formatRelativeAr } from "@/lib/format";
import { formatSpanAr } from "@/lib/arabic-duration";
import { NOUNS, countPhrase } from "@/lib/arabic-count";

/**
 * "Check for new data" button — the visitor-facing end of the refresh flow.
 *
 *   click -> POST /api/refresh {scope[, id]}
 *              202 started | already_running -> poll GET /api/freshness every 2s
 *              200 up_to_date               -> nothing new; just re-render
 *              429 cooldown | rate_limited  -> disable with a countdown
 *              404 / 403 / 503 / network    -> explain, never throw
 *   run finished -> router.refresh() so the server components re-read the
 *   (now invalidated) cache and the page shows the new data in place.
 *
 * The server is authoritative for every limit (DB cooldowns, origin check,
 * no force); this component only presents them.
 *
 * State lives in a small module-level store keyed by scope (+ dataset id), NOT
 * in the component: the header and the hero both render a catalog button, and
 * they must show the same run, the same countdown and the same outcome, with
 * ONE poller between them that also survives either instance unmounting
 * mid-run (e.g. the hero button when the visitor navigates away).
 */

type Scope = "catalog" | "dataset";
type Variant = "header" | "hero" | "inline";
type Phase = "idle" | "working" | "done" | "cooldown" | "error";

interface FreshnessResponse {
  lastDataChangeAt: string | null;
  lastRunStatus: "success" | "partial" | "failed" | "aborted" | null;
  /** Counts of the newest finished run: what REALLY happened ("partial" with failures is not "nothing new"). */
  lastRun?: { id: number; scope: string | null; status: string; updated: number; failed: number; deferred: number } | null;
  running: boolean;
  runScope?: string | null;
  progress: { done: number; total: number } | null;
  cooldown: { catalogUntil: string | null };
  refreshEnabled: boolean;
  dataset?: { refreshAvailableAt: string | null; removed: boolean; failed?: boolean; deferred?: boolean } | null;
}

interface State {
  enabled: boolean;
  phase: Phase;
  message: string;
  progress: { done: number; total: number } | null;
  /** Epoch ms until which the server will refuse another refresh, or null. */
  cooldownUntil: number | null;
}

const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 150_000;
const BUBBLE_MS = 7_000;

/** "N ثانية" up to ~90s, whole minutes beyond (an hour-long limit must not read "3488 ثانية"). */
function formatWait(seconds: number): string {
  return seconds <= 90 ? formatSpanAr(seconds) : formatSpanAr(Math.ceil(seconds / 60) * 60);
}

/** Does a run in progress (by its scope) cover what THIS button asked to refresh? */
function runCovers(scope: Scope, datasetId: string | undefined, runScope: string | null | undefined): boolean {
  if (!runScope) return true; // legacy/unknown scope: assume it is the catalog pass
  if (runScope === "changed" || runScope === "all") return true; // catalog-wide covers everything
  return scope === "dataset" && runScope === `dataset:${datasetId}`;
}

const INITIAL: State = { enabled: true, phase: "idle", message: "", progress: null, cooldownUntil: null };

class RefreshStore {
  private state: State = INITIAL;
  private listeners = new Set<() => void>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChange: string | null = null;
  private probed = false;
  /** runId of the run THIS visitor started (from the 202), so the result described is theirs; null when joining someone else's. */
  private ownRunId: number | null = null;
  /** The run in progress does not cover what was asked: say so instead of claiming "up to date". */
  private foreignRun = false;
  /** router.refresh of the most recently mounted button (it is app-global, any instance's works). */
  refreshPage: () => void = () => {};

  constructor(
    private readonly scope: Scope,
    private readonly datasetId: string | undefined,
  ) {}

  private get freshnessUrl(): string {
    return this.scope === "dataset" && this.datasetId
      ? `/api/freshness?dataset=${encodeURIComponent(this.datasetId)}`
      : "/api/freshness";
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): State => this.state;
  getServerSnapshot = (): State => INITIAL;

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Final state + a transient message; the aria-live region always carries it. */
  private settle(phase: Phase, message: string) {
    this.set({ phase, message, progress: null });
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => this.set({ message: "" }), BUBBLE_MS);
  }

  private startCooldown(untilIso: string | null, fallbackSeconds = 0) {
    const until = untilIso ? Date.parse(untilIso) : Date.now() + fallbackSeconds * 1000;
    if (Number.isFinite(until) && until > Date.now()) this.set({ cooldownUntil: until });
  }

  private cooldownFrom(data: FreshnessResponse): string | null {
    return this.scope === "dataset" ? (data.dataset?.refreshAvailableAt ?? null) : data.cooldown.catalogUntil;
  }

  /** One cheap probe: feature flag, run already in flight, cooldown already ticking. Once per store. */
  async probe(): Promise<void> {
    if (this.probed) return;
    this.probed = true;
    try {
      const res = await fetch(this.freshnessUrl, { cache: "no-store" });
      if (!res.ok) return;
      const data: FreshnessResponse = await res.json();
      this.lastChange = data.lastDataChangeAt;
      if (!data.refreshEnabled || (this.scope === "dataset" && (!data.dataset || data.dataset.removed))) {
        this.set({ enabled: false });
        return;
      }
      this.startCooldown(this.cooldownFrom(data));
      if (data.running && this.state.phase !== "working") {
        this.ownRunId = null;
        this.foreignRun = !runCovers(this.scope, this.datasetId, data.runScope);
        this.set({ phase: "working", progress: data.progress });
        this.poll(Date.now());
      }
    } catch {
      this.probed = false; // offline: let the next mount try again; the button stays usable
    }
  }

  private poll(startedAt: number) {
    if (this.pollTimer) return; // exactly one poller per store
    const tick = async () => {
      this.pollTimer = null;
      try {
        const res = await fetch(this.freshnessUrl, { cache: "no-store" });
        if (res.ok) {
          const data: FreshnessResponse = await res.json();
          if (data.running) {
            this.set({ progress: data.progress });
          } else {
            this.finish(data);
            this.refreshPage();
            return;
          }
        }
      } catch {
        // Transient network error: keep polling until the timeout below.
      }
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        this.settle("done", "ما زال التحديث جاريًا في الخلفية — أعد تحميل الصفحة بعد قليل");
        return;
      }
      this.pollTimer = setTimeout(tick, POLL_MS);
    };
    this.pollTimer = setTimeout(tick, POLL_MS);
  }

  /** The run has ended: describe what REALLY happened, from the server's counts, not from "nothing changed". */
  private finish(data: FreshnessResponse) {
    const run = data.lastRun ?? null;
    const mine = this.ownRunId !== null && run?.id === this.ownRunId;
    const foreign = this.foreignRun;
    this.ownRunId = null;
    this.foreignRun = false;

    if (data.lastRunStatus === "failed" || data.lastRunStatus === "aborted") {
      this.settle("error", "تعذّر الوصول إلى المصدر الآن — تُعرض آخر بيانات محفوظة");
      return;
    }
    const changed = data.lastDataChangeAt !== this.lastChange;
    this.lastChange = data.lastDataChangeAt;
    this.startCooldown(this.cooldownFrom(data));

    if (foreign && !mine) {
      // The run that just ended was somebody else's and did not cover this button's scope.
      this.settle("done", "انتهى تحديث آخر كان قيد التنفيذ — اضغط مجددًا للتحقق من هذه البيانات");
      return;
    }
    if (this.scope === "dataset") {
      const d = data.dataset;
      if (d?.deferred) {
        this.settle("done", "هذه المجموعة كبيرة وستُحدَّث ضمن المزامنة المجدولة، وتُعرض الآن آخر نسخة محفوظة");
      } else if (d?.failed) {
        this.settle("error", "تعذّر تحديث هذه المجموعة الآن — تُعرض آخر نسخة محفوظة");
      } else {
        this.settle("done", changed ? "تم تحديث البيانات" : "البيانات محدّثة بالفعل — لا جديد في المصدر");
      }
      return;
    }
    // Catalog-wide: only claim "nothing new" when the run really found nothing to do or to defer.
    const updated = mine || run ? (run?.updated ?? 0) : changed ? 1 : 0;
    const failed = run?.failed ?? 0;
    const deferred = run?.deferred ?? 0;
    const parts: string[] = [];
    if (updated > 0) parts.push(`تم تحديث ${countPhrase(updated, NOUNS.dataset)}`);
    if (deferred > 0) {
      parts.push(
        updated > 0
          ? `وأُجّل ${countPhrase(deferred, NOUNS.dataset)} كبيرة إلى المزامنة المجدولة`
          : `اكتُشفت بيانات جديدة في ${countPhrase(deferred, NOUNS.dataset, { oblique: true })} كبيرة وستُحدَّث ضمن المزامنة المجدولة`,
      );
    }
    if (failed > 0) {
      parts.push(
        parts.length > 0 ? `وتعذّر تحديث ${countPhrase(failed, NOUNS.dataset)}` : `تعذّر تحديث ${countPhrase(failed, NOUNS.dataset)} — تُعرض آخر بيانات محفوظة`,
      );
    }
    if (parts.length > 0) {
      this.settle(failed > 0 && updated === 0 ? "error" : "done", parts.join(" "));
    } else {
      this.settle("done", changed ? "تم تحديث البيانات" : "البيانات محدّثة بالفعل — لا جديد في المصدر");
    }
  }

  async click(): Promise<void> {
    if (this.state.phase === "working") return;
    this.set({ phase: "working", message: "", progress: null });
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.scope === "dataset" ? { scope: this.scope, id: this.datasetId } : { scope: this.scope }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        retryAfterSeconds?: number;
        checkedAt?: string;
        runId?: number;
        runScope?: string | null;
      };
      if (res.status === 202 || (res.ok && (body.status === "started" || body.status === "already_running"))) {
        this.ownRunId = body.status === "started" && typeof body.runId === "number" ? body.runId : null;
        this.foreignRun = body.status === "already_running" && !runCovers(this.scope, this.datasetId, body.runScope);
        this.poll(Date.now());
        return;
      }
      if (res.ok && body.status === "up_to_date") {
        // The server consumed the catalog cooldown to answer this; pick it up now
        // so the button shows the countdown instead of a surprise 429 on the next press.
        await this.syncCooldown();
        this.settle("done", `البيانات محدّثة بالفعل — آخر فحص ${formatRelativeAr(body.checkedAt)}`);
        this.refreshPage();
        return;
      }
      if (res.status === 429 && body.status === "rate_limited") {
        // Too many presses from this client: nothing was refreshed, so do not say it was
        // and do not re-render as if someone else had just pulled data in.
        const wait = Math.max(1, Math.round(body.retryAfterSeconds ?? 3600));
        this.startCooldown(null, wait);
        this.settle("cooldown", `تجاوزت الحد المسموح من محاولات التحديث — حاول بعد ${formatWait(wait)}`);
        return;
      }
      if (res.status === 429) {
        const wait = Math.max(1, Math.round(body.retryAfterSeconds ?? 60));
        this.startCooldown(null, wait);
        this.settle("cooldown", `حُدّثت البيانات للتو — يمكنك المحاولة بعد ${formatWait(wait)}`);
        this.refreshPage(); // someone else just refreshed: show what they pulled in
        return;
      }
      if (res.status === 404) return this.settle("error", "هذه المجموعة غير متوفرة في المصدر الحالي");
      if (res.status === 503) return this.set({ enabled: false });
      this.settle("error", "تعذّر بدء التحديث الآن، حاول لاحقًا");
    } catch {
      this.settle("error", "تعذّر الاتصال بالخادم — تحقق من اتصالك وحاول مجددًا");
    }
  }

  /** Read the server's current cooldown (best effort). */
  private async syncCooldown(): Promise<void> {
    try {
      const res = await fetch(this.freshnessUrl, { cache: "no-store" });
      if (res.ok) this.startCooldown(this.cooldownFrom((await res.json()) as FreshnessResponse));
    } catch {
      // Not critical: the next press simply gets the server's 429.
    }
  }

  /** Cooldown expired: clear it (the button re-enables). */
  expireCooldown() {
    if (this.state.cooldownUntil && Date.now() >= this.state.cooldownUntil) this.set({ cooldownUntil: null });
  }
}

const stores = new Map<string, RefreshStore>();
function storeFor(scope: Scope, datasetId?: string): RefreshStore {
  const key = scope === "dataset" ? `dataset:${datasetId ?? ""}` : "catalog";
  let store = stores.get(key);
  if (!store) {
    store = new RefreshStore(scope, datasetId);
    stores.set(key, store);
  }
  return store;
}

const VARIANT_CLASS: Record<Variant, string> = {
  header:
    "border border-line-light bg-white text-sea-900 hover:bg-sand-100 disabled:hover:bg-white px-3 sm:px-4",
  hero: "border border-sand-100/40 bg-white/5 text-sand-50 hover:bg-white/15 disabled:hover:bg-white/5 px-5",
  inline: "border border-line-light bg-white text-sea-900 hover:bg-sand-100 disabled:hover:bg-white px-4",
};

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-4 w-4 shrink-0 ${spinning ? "motion-safe:animate-spin" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function RefreshButton({
  scope = "catalog",
  datasetId,
  variant = "inline",
  label,
  className = "",
}: {
  scope?: Scope;
  /** Required when scope is "dataset". */
  datasetId?: string;
  variant?: Variant;
  /** Overrides the idle label (default: "تحديث" in the header, "تحديث البيانات" elsewhere). */
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const store = storeFor(scope, datasetId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

  // Let the store re-render the page through whichever instance is mounted, and probe once.
  useEffect(() => {
    store.refreshPage = () => router.refresh();
    void store.probe();
  }, [store, router]);

  // Tick once a second only while a cooldown is counting down; re-render via a store no-op.
  const cooling = state.cooldownUntil !== null && state.phase !== "working";
  useEffect(() => {
    if (!state.cooldownUntil) return;
    const timer = setInterval(() => store.expireCooldown(), 1_000);
    return () => clearInterval(timer);
  }, [store, state.cooldownUntil]);

  const secondsLeft = useCountdown(state.cooldownUntil);
  const onClick = useCallback(() => void store.click(), [store]);

  if (!state.enabled) return null;

  const working = state.phase === "working";
  const isCooling = cooling && secondsLeft > 0;
  const idleLabel = label ?? (variant === "header" ? "تحديث" : "تحديث البيانات");
  const buttonText = working
    ? state.progress && state.progress.total > 1
      ? `جارٍ التحديث (${state.progress.done}/${state.progress.total})`
      : "جارٍ التحقق…"
    : isCooling
      ? `بعد ${formatWait(secondsLeft)}`
      : idleLabel;
  const showBubble = variant === "header" && state.message !== "";

  return (
    <div className={`relative inline-flex flex-col items-start gap-1 ${className}`}>
      <button
        type="button"
        onClick={onClick}
        disabled={working || isCooling}
        aria-busy={working}
        title={isCooling ? "تم التحديث للتو — الرجاء الانتظار قليلًا قبل المحاولة مجددًا" : "تحقق من وجود بيانات جديدة في المصدر الرسمي"}
        className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${VARIANT_CLASS[variant]}`}
      >
        <RefreshIcon spinning={working} />
        <span className={variant === "header" ? "sr-only sm:not-sr-only" : ""}>{buttonText}</span>
      </button>

      {/* Always-present live region so assistive tech announces every outcome. */}
      <span
        role="status"
        aria-live="polite"
        className={
          variant === "header"
            ? showBubble
              ? "pointer-events-none absolute end-0 top-full z-50 mt-2 w-max max-w-[16rem] rounded-lg bg-sea-900 px-3 py-2 text-xs font-medium text-sand-50 shadow-lg"
              : "sr-only"
            : `text-xs ${variant === "hero" ? "text-sand-100/90" : "text-ink/70"} ${state.message ? "" : "sr-only"}`
        }
      >
        {state.message || (working ? "جارٍ التحقق من وجود بيانات جديدة" : "")}
      </span>
    </div>
  );
}

/** Seconds left until `untilMs` (0 when none), re-evaluated every second while active. */
function useCountdown(untilMs: number | null): number {
  return useSyncExternalStore(
    (onChange) => {
      if (!untilMs) return () => {};
      const timer = setInterval(onChange, 1_000);
      return () => clearInterval(timer);
    },
    () => (untilMs ? Math.max(0, Math.ceil((untilMs - Date.now()) / 1000)) : 0),
    () => 0,
  );
}
