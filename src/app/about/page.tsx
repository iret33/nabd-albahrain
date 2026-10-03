import Link from "next/link";
import { getPortalStats } from "@/lib/queries";
import { getAutoSyncIntervalMinutes, getStaleAfterMs, loadPublicRefreshConfig } from "@/lib/sync/config";
import { freshnessNotice } from "@/lib/freshness-notice";
import { formatEveryAr, formatSpanAr } from "@/lib/arabic-duration";
import { listingMetadata } from "@/lib/seo";
import { FreshnessLine } from "@/components/freshness-line";
import { NumberLatin } from "@/components/number-latin";
import { PearlLattice } from "@/components/pearl-lattice";
import { RefreshButton } from "@/components/refresh-button";

export const metadata = listingMetadata({
  title: "عن المشروع",
  description:
    "نبض البحرين مشروع مستقل غير رسمي يعرض بصريًا بيانات بوابة data.gov.bh المفتوحة لمملكة البحرين — عن المشروع، المصدر، وكيف تُحدَّث البيانات.",
  path: "/about",
});

const linkClass =
  "font-medium text-sea-900 underline decoration-pearl decoration-2 underline-offset-4 transition-colors hover:text-coral";

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-heading` : undefined} className="mt-10 scroll-mt-6">
      <h2 id={id ? `${id}-heading` : undefined} className="font-display text-xl font-bold text-sea-900">
        {title}
      </h2>
      <div className="mt-3 max-w-2xl space-y-4 text-sm leading-8 text-ink/80">{children}</div>
    </section>
  );
}

function ExternalPortalLink({ children }: { children: React.ReactNode }) {
  return (
    <a href="https://data.gov.bh" target="_blank" rel="noopener noreferrer" className={linkClass}>
      {children}
    </a>
  );
}

export default async function AboutPage() {
  // The copy below quotes the REAL configuration of this deployment (the scheduler interval, the cooldowns,
  // the kill switch), so it cannot drift from what the site actually does.
  const stats = await getPortalStats();
  const intervalMinutes = getAutoSyncIntervalMinutes();
  const refresh = loadPublicRefreshConfig();
  const notice = freshnessNotice({
    latestRunStatus: stats.latestRun?.status,
    lastSuccessAt: stats.lastSuccessAt,
    now: new Date(),
    staleAfterMs: getStaleAfterMs(),
  });

  return (
    <>
      <section className="surface-dark bg-sea-900 text-sand-50">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <p className="font-display text-sm font-bold tracking-wide text-pearl">عن المشروع</p>
          <h1 className="mt-3 max-w-2xl font-display text-3xl font-black leading-tight sm:text-4xl">
            نبض البحرين
          </h1>
          <p className="mt-4 max-w-xl text-base text-sand-100/85 sm:text-lg">
            لوحة بيانات عربية مستقلة تعيد عرض كل مجموعات البيانات المفتوحة في بوابة data.gov.bh
            الرسمية لمملكة البحرين بشكل بصري وسهل التصفح.
          </p>
        </div>
      </section>

      <PearlLattice />

      <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <section aria-labelledby="status-heading" className="mt-2 rounded-2xl border border-line-light bg-white p-5 shadow-sm">
          <h2 id="status-heading" className="font-display text-lg font-bold text-sea-900">
            حالة البيانات الآن
          </h2>
          <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <FreshnessLine
              items={[
                { label: "آخر تحقق من المصدر", iso: stats.lastCheckedAt?.toISOString() ?? null },
                { label: "آخر تغيير في البيانات", iso: stats.lastDataChangeAt?.toISOString() ?? null },
                { label: "آخر مزامنة ناجحة", iso: stats.lastSuccessAt?.toISOString() ?? null },
              ]}
              notice={notice}
            />
            <RefreshButton variant="inline" />
          </div>
        </section>

        <Section title="مشروع مستقل وغير رسمي">
          <p>
            نبض البحرين مشروع مستقل من تطوير جهة خاصة، وليس تابعًا لأي جهة حكومية في مملكة
            البحرين ولا لبوابة البيانات المفتوحة الرسمية data.gov.bh، ولا يمثّلها بأي شكل من
            الأشكال. الهدف من المشروع هو تسهيل استكشاف البيانات الحكومية المفتوحة المتاحة أصلًا
            للعموم، من خلال عرض بصري عربي أكثر سهولة.
          </p>
        </Section>

        <Section title="مصدر البيانات">
          <p>
            جميع البيانات المعروضة في هذا الموقع مأخوذة مباشرة من{" "}
            <ExternalPortalLink>بوابة البيانات المفتوحة الرسمية لمملكة البحرين data.gov.bh</ExternalPortalLink>{" "}
            عبر واجهتها البرمجية العامة (Explore API). لا يقوم هذا المشروع بتعديل قيم البيانات
            نفسها — فقط بتنظيمها وعرضها بصريًا.
          </p>
          <p>
            نعرض العنوان العربي لمجموعة البيانات حين تنشره البوابة نفسها، ويظهر العنوان الإنجليزي
            الأصلي تحته. لا نترجم أي شيء آليًا: عناوين المجموعات التي لا تحمل عنوانًا عربيًا،
            وأسماء الفئات والجهات والحقول، تبقى كما وردت من المصدر.
          </p>
        </Section>

        <Section id="freshness" title="كيف تُحدَّث البيانات؟">
          <p>
            {intervalMinutes > 0 ? (
              <>
                يتحقق الخادم من البوابة تلقائيًا <strong>{formatEveryAr(intervalMinutes)}</strong>، ويعيد
                تنزيل المجموعات التي تغيّرت فقط.
              </>
            ) : (
              <>
                لا تعمل المزامنة الدورية المدمجة في هذا الخادم حاليًا؛ تُجرى المزامنة بجدولة خارجية
                (مرة يوميًا في الغالب).
              </>
            )}{" "}
            قد يظهر فارق بين وقت نشر تحديث في المصدر الرسمي ووقت ظهوره هنا بمقدار هذه الدورة.
          </p>
          <p>
            {refresh.enabled ? (
              <>
                لا داعي للانتظار: زر <strong>«تحديث»</strong> في أعلى كل صفحة (وفي صفحة كل مجموعة بيانات)
                يطلب من الخادم التحقق من البوابة الآن، ويعرض التقدم ثم يحدّث الصفحة بالبيانات الجديدة.
                لحماية البوابة الرسمية من الضغط، يُسمح بتحقق واحد كل{" "}
                <strong>{formatSpanAr(refresh.catalogCooldownSeconds)}</strong> لجميع الزوار معًا (
                <strong>{formatSpanAr(refresh.datasetCooldownSeconds)}</strong> لكل مجموعة بيانات على حدة)؛ فإن
                ضغط زائر آخر الزر للتو فستظهر لك نتيجته. المجموعات التي تزيد عن{" "}
                <NumberLatin value={refresh.maxRecords} /> سجل لا يعيد الزر تنزيلها، وتتولاها المزامنة الدورية.
              </>
            ) : (
              <>زر التحديث اليدوي معطّل على هذا الخادم حاليًا، وتصل البيانات الجديدة عبر المزامنة الدورية فقط.</>
            )}
          </p>
          <p>تحمل البيانات وقتين مختلفين، وهما لا يعنيان الشيء نفسه:</p>
          <ul className="list-disc space-y-2 ps-6">
            <li>
              <strong>آخر تحقق من المصدر:</strong> متى سألنا البوابة عن جديدها آخر مرة. قد يكون قريبًا جدًا حتى لو
              لم يتغير شيء.
            </li>
            <li>
              <strong>آخر تغيير في البيانات:</strong> متى أعدنا تنزيل مجموعة بيانات لأن البوابة نشرت فيها تعديلًا.
            </li>
          </ul>
          <p>
            التاريخ المعروض على بطاقة كل مجموعة («عُدّلت …») هو تاريخ تعديلها في المصدر الرسمي لا تاريخ مزامنتها هنا،
            وكل الأوقات بتوقيت البحرين (UTC+3). وإن فشلت آخر محاولة تحديث، أو تأخرت المزامنة الناجحة عن{" "}
            <strong>{formatSpanAr(getStaleAfterMs() / 1000)}</strong>، يظهر تنبيه واضح تحت وقت التحديث بدل أن
            نُظهر البيانات وكأنها حديثة. تابع الجديد من صفحة <Link href="/updates" className={linkClass}>آخر التحديثات</Link>{" "}
            أو عبر <a href="/feed.xml" className={linkClass}>خلاصة Atom</a>.
          </p>
        </Section>

        <Section title="واجهة برمجية للمطورين">
          <p>
            يمكن للمطورين والباحثين قراءة الكتالوج وسجلات أي مجموعة بيانات بصيغة JSON أو CSV من واجهة
            عامة مفتوحة بلا مفتاح. التفاصيل والأمثلة في صفحة{" "}
            <Link href="/developers" className={linkClass}>
              واجهة المطورين
            </Link>
            .
          </p>
        </Section>

        <Section title="إخلاء مسؤولية">
          <p>
            هذا الموقع أداة عرض واستكشاف فقط، وقد يحتوي على تأخر بسيط في التحديث أو أخطاء غير
            مقصودة أثناء المعالجة. لا يُعتد بالأرقام أو المؤشرات المعروضة هنا كمصدر رسمي أو
            نهائي — الأرقام والبيانات الرسمية والمعتمدة هي فقط ما يُنشر مباشرة على{" "}
            <ExternalPortalLink>data.gov.bh</ExternalPortalLink>. لأي استخدام رسمي أو بحثي أو قانوني،
            يُرجى دائمًا الرجوع إلى المصدر الأصلي.
          </p>
        </Section>

        <Section title="التواصل">
          <p>
            لأي استفسار أو ملاحظة حول هذا المشروع المستقل (وليس حول بيانات data.gov.bh نفسها، والتي
            تخص الجهات الحكومية الناشرة لها)، يمكن التواصل عبر{" "}
            <a href="https://hekkapp.com" target="_blank" rel="noopener noreferrer" className={linkClass}>
              hekkapp.com
            </a>
            .
          </p>
        </Section>

        <div className="mt-12 flex flex-wrap gap-3">
          <Link
            href="/categories"
            className="inline-flex min-h-11 items-center rounded-full bg-sea-900 px-6 py-3 text-sm font-bold text-sand-50 transition-transform motion-safe:hover:scale-105"
          >
            تصفح الفئات
          </Link>
          <Link
            href="/publishers"
            className="inline-flex min-h-11 items-center rounded-full border border-ink/30 px-6 py-3 text-sm font-bold text-ink transition-colors hover:border-coral hover:text-coral"
          >
            الجهات الحكومية
          </Link>
        </div>
      </div>
    </>
  );
}
