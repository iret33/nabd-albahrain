"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatRelativeAr } from "@/lib/format";

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
 * no force); this component only presents them. On mount it makes one cheap
 * GET /api/freshness so a run that is already in flight, a cooldown that is
 * already ticking, or a disabled feature (PUBLIC_REFRESH_ENABLED=0) is
 * reflected immediately. It does not poll while idle.
 */

type Scope = "catalog" | "dataset";
type Variant = "header" | "hero" | "inline";
type Phase = "idle" | "working" | "done" | "cooldown" | "error";

interface FreshnessResponse {
  lastDataChangeAt: string | null;
  lastRunStatus: "success" | "partial" | "failed" | "aborted" | null;
  running: boolean;
  progress: { done: number; total: number } | null;
  cooldown: { catalogUntil: string | null };
  refreshEnabled: boolean;
  dataset?: { refreshAvailableAt: string | null; removed: boolean } | null;
}

const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 150_000;
const BUBBLE_MS = 7_000;

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

function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds} ثانية`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "دقيقة" : `${minutes} دقائق`;
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
  const [enabled, setEnabled] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const mounted = useRef(true);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastChange = useRef<string | null>(null);

  const freshnessUrl = scope === "dataset" && datasetId
    ? `/api/freshness?dataset=${encodeURIComponent(datasetId)}`
    : "/api/freshness";

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  /** Final state + a transient message; the aria-live region always carries it. */
  const settle = useCallback((next: Phase, text: string) => {
    if (!mounted.current) return;
    setPhase(next);
    setMessage(text);
    setProgress(null);
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(() => {
      if (mounted.current) setMessage("");
    }, BUBBLE_MS);
  }, []);

  const startCooldown = useCallback((untilIso: string | null, fallbackSeconds = 0) => {
    const until = untilIso ? Date.parse(untilIso) : Date.now() + fallbackSeconds * 1000;
    if (Number.isFinite(until) && until > Date.now()) setCooldownUntil(until);
  }, []);

  const poll = useCallback(
    (startedAt: number) => {
      const tick = async () => {
        if (!mounted.current) return;
        try {
          const res = await fetch(freshnessUrl, { cache: "no-store" });
          if (res.ok) {
            const data: FreshnessResponse = await res.json();
            if (data.running) {
              setProgress(data.progress);
            } else {
              stopPolling();
              if (data.lastRunStatus === "failed" || data.lastRunStatus === "aborted") {
                settle("error", "تعذّر الوصول إلى المصدر الآن — تُعرض آخر بيانات محفوظة");
              } else {
                const changed = data.lastDataChangeAt !== lastChange.current;
                lastChange.current = data.lastDataChangeAt;
                startCooldown(scope === "dataset" ? (data.dataset?.refreshAvailableAt ?? null) : data.cooldown.catalogUntil);
                settle("done", changed ? "تم تحديث البيانات" : "البيانات محدّثة بالفعل — لا جديد في المصدر");
              }
              router.refresh();
              return;
            }
          }
        } catch {
          // Transient network error: keep polling until the timeout below.
        }
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          stopPolling();
          settle("done", "ما زال التحديث جاريًا في الخلفية — أعد تحميل الصفحة بعد قليل");
          return;
        }
        pollTimer.current = setTimeout(tick, POLL_MS);
      };
      pollTimer.current = setTimeout(tick, POLL_MS);
    },
    [freshnessUrl, router, scope, settle, startCooldown, stopPolling],
  );

  // One cheap probe on mount: feature flag, run already in flight, cooldown already ticking.
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(freshnessUrl, { cache: "no-store", signal: controller.signal });
        if (!res.ok) return;
        const data: FreshnessResponse = await res.json();
        lastChange.current = data.lastDataChangeAt;
        if (!data.refreshEnabled || (scope === "dataset" && (!data.dataset || data.dataset.removed))) {
          setEnabled(false);
          return;
        }
        startCooldown(scope === "dataset" ? (data.dataset?.refreshAvailableAt ?? null) : data.cooldown.catalogUntil);
        if (data.running) {
          setPhase("working");
          setProgress(data.progress);
          poll(Date.now());
        }
      } catch {
        // Offline / aborted: leave the button usable; a click will report the problem.
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
      stopPolling();
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    };
  }, [freshnessUrl, poll, scope, startCooldown, stopPolling]);

  // Tick once a second only while a cooldown is counting down.
  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= cooldownUntil) setCooldownUntil(null);
    }, 1_000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  const onClick = useCallback(async () => {
    if (phase === "working") return;
    setPhase("working");
    setMessage("");
    setProgress(null);
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scope === "dataset" ? { scope, id: datasetId } : { scope }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        retryAfterSeconds?: number;
        checkedAt?: string;
      };
      if (res.status === 202 || (res.ok && (body.status === "started" || body.status === "already_running"))) {
        poll(Date.now());
        return;
      }
      if (res.ok && body.status === "up_to_date") {
        settle("done", `البيانات محدّثة بالفعل — آخر فحص ${formatRelativeAr(body.checkedAt)}`);
        router.refresh();
        return;
      }
      if (res.status === 429) {
        const wait = Math.max(1, Math.round(body.retryAfterSeconds ?? 60));
        startCooldown(null, wait);
        settle("cooldown", `حُدّثت البيانات للتو — يمكنك المحاولة بعد ${formatCountdown(wait)}`);
        router.refresh(); // someone else just refreshed: show what they pulled in
        return;
      }
      if (res.status === 404) return settle("error", "هذه المجموعة غير متوفرة في المصدر الحالي");
      if (res.status === 503) {
        setEnabled(false);
        return;
      }
      settle("error", "تعذّر بدء التحديث الآن، حاول لاحقًا");
    } catch {
      settle("error", "تعذّر الاتصال بالخادم — تحقق من اتصالك وحاول مجددًا");
    }
  }, [datasetId, phase, poll, router, scope, settle, startCooldown]);

  if (!enabled) return null;

  const working = phase === "working";
  const remaining = cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - now) / 1000)) : 0;
  const cooling = remaining > 0 && !working;
  const idleLabel = label ?? (variant === "header" ? "تحديث" : "تحديث البيانات");
  const buttonText = working
    ? progress && progress.total > 1
      ? `جارٍ التحديث (${progress.done}/${progress.total})`
      : "جارٍ التحقق…"
    : cooling
      ? `بعد ${formatCountdown(remaining)}`
      : idleLabel;
  const showBubble = variant === "header" && message !== "";

  return (
    <div className={`relative inline-flex flex-col items-start gap-1 ${className}`}>
      <button
        type="button"
        onClick={onClick}
        disabled={working || cooling}
        aria-busy={working}
        title={cooling ? "تم التحديث للتو — الرجاء الانتظار قليلًا قبل المحاولة مجددًا" : "تحقق من وجود بيانات جديدة في المصدر الرسمي"}
        className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${VARIANT_CLASS[variant]}`}
      >
        <RefreshIcon spinning={working} />
        <span className={variant === "header" ? "hidden sm:inline" : ""}>{buttonText}</span>
      </button>

      {/* Always-present live region so assistive tech announces every outcome. */}
      <span
        role="status"
        aria-live="polite"
        className={
          variant === "header"
            ? showBubble
              ? "absolute end-0 top-full z-50 mt-2 w-max max-w-[16rem] rounded-lg bg-sea-900 px-3 py-2 text-xs font-medium text-sand-50 shadow-lg"
              : "sr-only"
            : `text-xs ${variant === "hero" ? "text-sand-100/90" : "text-ink/70"} ${message ? "" : "sr-only"}`
        }
      >
        {message || (working ? "جارٍ التحقق من وجود بيانات جديدة" : "")}
      </span>
    </div>
  );
}
