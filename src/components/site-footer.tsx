import Link from "next/link";
import { getPortalStats } from "@/lib/queries";
import { getStaleAfterMs } from "@/lib/sync/config";
import { freshnessNotice } from "@/lib/freshness-notice";
import { FreshnessLine } from "@/components/freshness-line";

const linkClass = "inline-flex min-h-11 items-center rounded transition-colors hover:text-coral";

/**
 * "آخر مزامنة ناجحة" plus an honest notice when the last run failed or the data
 * is stale. A cached read, awaited in place (no <Suspense>: streamed content stays
 * hidden in a browser without JavaScript), and wrapped in try/catch because it
 * renders on EVERY page, including the 404 and error pages: a database hiccup
 * must cost this one line, not the whole page (an exception here would be caught
 * by the nearest error boundary and replace the page content).
 */
async function FooterFreshness() {
  try {
    const stats = await getPortalStats();
    const notice = freshnessNotice({
      latestRunStatus: stats.latestRun?.status,
      lastSuccessAt: stats.lastSuccessAt,
      now: new Date(),
      staleAfterMs: getStaleAfterMs(),
    });
    if (!stats.lastSuccessAt && !notice) return null;
    return (
      <FreshnessLine
        items={[{ label: "آخر مزامنة ناجحة", iso: stats.lastSuccessAt?.toISOString() ?? null }]}
        notice={notice}
      />
    );
  } catch (err) {
    console.error("[site-footer] freshness unavailable:", err);
    return null;
  }
}

/**
 * Shared site footer. Every page must show this exact attribution line
 * (per project spec, unchanged since Phase 4) crediting the official
 * data.gov.bh portal — this project is an independent, unofficial
 * mirror/visualization of it. Above it: the secondary nav (including the
 * what's-new page, the Atom feed and the developer API) and the freshness
 * line, so the age of the data is visible from every page.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-line-light bg-sand-100">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {/* Printed pages keep the attribution line below and drop the link list and the freshness line. */}
        <nav aria-label="روابط إضافية" className="print:hidden">
          <ul role="list" className="flex flex-wrap justify-center gap-x-5 text-sm font-medium text-ink/80 sm:justify-start">
            <li>
              <Link href="/categories" className={linkClass}>
                الفئات
              </Link>
            </li>
            <li>
              <Link href="/publishers" className={linkClass}>
                الجهات الحكومية
              </Link>
            </li>
            <li>
              <Link href="/updates" className={linkClass}>
                آخر التحديثات
              </Link>
            </li>
            <li>
              <Link href="/search" className={linkClass}>
                البحث
              </Link>
            </li>
            <li>
              <Link href="/developers" className={linkClass}>
                واجهة المطورين
              </Link>
            </li>
            <li>
              <a href="/feed.xml" className={linkClass}>
                خلاصة Atom
              </a>
            </li>
            <li>
              <Link href="/about" className={linkClass}>
                عن المشروع
              </Link>
            </li>
          </ul>
        </nav>

        <div className="mt-2 flex min-h-5 justify-center sm:justify-start print:hidden">
          <FooterFreshness />
        </div>

        <p className="mt-4 text-center text-sm text-ink/80 sm:text-start">
          المصدر:{" "}
          <a
            href="https://data.gov.bh"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-sea-900 underline decoration-pearl decoration-2 underline-offset-4 transition-colors hover:text-coral"
          >
            بوابة البيانات المفتوحة لمملكة البحرين data.gov.bh
          </a>{" "}
          — مشروع مستقل غير رسمي
        </p>
      </div>
    </footer>
  );
}
