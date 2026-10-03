import { formatDateAr } from "@/lib/format";

/**
 * Shown when the portal's catalog no longer lists the dataset (`removedAt`).
 * We keep serving the last copy we saved, but visitors must not mistake it
 * for live data: the banner says so first, with the date of that copy, and
 * the page hides the refresh button and the official download links (the
 * portal no longer has them).
 */
export function RemovedBanner({
  removedAt,
  lastSyncedAt,
}: {
  removedAt: Date | null;
  lastSyncedAt: Date | null;
}) {
  return (
    <section
      aria-label="تنبيه: مجموعة أُزيلت من المصدر"
      className="mt-5 rounded-2xl border border-coral/40 bg-coral/5 px-5 py-4"
    >
      <p className="font-display text-base font-bold leading-7 text-coral">
        أُزيلت هذه المجموعة من المصدر الرسمي
        {lastSyncedAt ? (
          <>
            {" — "}آخر نسخة محفوظة بتاريخ{" "}
            <time dateTime={lastSyncedAt.toISOString()} className="whitespace-nowrap">
              {formatDateAr(lastSyncedAt)}
            </time>
          </>
        ) : null}
      </p>
      <p className="mt-1 text-sm leading-7 text-ink/80">
        البيانات المعروضة أدناه نسخة أرشيفية قد لا تعكس الوضع الحالي، ولا يمكن تحديثها من هنا
        {removedAt ? (
          <>
            {" "}
            (رُصدت الإزالة في{" "}
            <time dateTime={removedAt.toISOString()} className="whitespace-nowrap">
              {formatDateAr(removedAt)}
            </time>
            )
          </>
        ) : null}
        .
      </p>
    </section>
  );
}
