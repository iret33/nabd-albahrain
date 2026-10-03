import type { ReactNode } from "react";
import { listingMetadata } from "@/lib/seo";
import { SITE_URL } from "@/lib/site";
import { API_LIST_DEFAULT_LIMIT, API_LIST_MAX_LIMIT, API_RECORDS_DEFAULT_LIMIT, API_RECORDS_MAX_LIMIT } from "@/lib/api-v1";
import { PearlLattice } from "@/components/pearl-lattice";

export const metadata = listingMetadata({
  title: "واجهة المطورين",
  description:
    "واجهة JSON عامة ومجانية للقراءة فقط لكتالوج مجموعات البيانات المفتوحة لمملكة البحرين وسجلاتها، مع تصدير CSV وترقيم بالمؤشر.",
  path: "/developers",
});

const linkClass =
  "font-medium text-sea-900 underline decoration-pearl decoration-2 underline-offset-4 transition-colors hover:text-coral";

/** Code is always left-to-right, whatever the page direction. Focusable so a keyboard can scroll a long line. */
function Code({ children }: { children: string }) {
  return (
    <pre
      dir="ltr"
      tabIndex={0}
      className="overflow-x-auto rounded-xl bg-sea-900 p-4 text-left text-xs leading-6 text-sand-50"
    >
      <code>{children}</code>
    </pre>
  );
}

/** Short tokens never break across lines; pass `wrap` for a long URL that must be able to. */
function Inline({ children, wrap = false }: { children: ReactNode; wrap?: boolean }) {
  return (
    <code
      dir="ltr"
      className={`rounded bg-sand-100 px-1.5 py-0.5 text-[0.85em] text-sea-900 ${wrap ? "break-all" : "whitespace-nowrap"}`}
    >
      {children}
    </code>
  );
}

function Params({ rows }: { rows: Array<[name: string, description: ReactNode]> }) {
  return (
    <dl className="divide-y divide-line-light rounded-xl border border-line-light bg-white">
      {rows.map(([name, description]) => (
        <div key={name} className="grid gap-1 px-4 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4">
          <dt>
            <Inline>{name}</Inline>
          </dt>
          <dd className="text-sm leading-7 text-ink/80">{description}</dd>
        </div>
      ))}
    </dl>
  );
}

function Endpoint({ id, path, title, children }: { id: string; path: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="mt-12 max-w-3xl scroll-mt-6">
      <h2 id={`${id}-heading`} className="font-display text-xl font-bold text-sea-900">
        {title}
      </h2>
      <p dir="ltr" className="mt-2 w-fit rounded-lg bg-sea-900 px-3 py-1.5 text-left text-sm font-medium text-sand-50">
        <span className="text-pearl">GET</span> {path}
      </p>
      <div className="mt-4 space-y-4 text-sm leading-8 text-ink/80">{children}</div>
    </section>
  );
}

export default function DevelopersPage() {
  const base = `${SITE_URL}/api/v1`;
  return (
    <>
      <section className="surface-dark bg-sea-900 text-sand-50">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <p className="font-display text-sm font-bold tracking-wide text-pearl">للمطورين والباحثين</p>
          <h1 className="mt-3 max-w-2xl font-display text-3xl font-black leading-tight sm:text-4xl">واجهة المطورين</h1>
          <p className="mt-4 max-w-2xl text-base text-sand-100/85 sm:text-lg">
            اقرأ كتالوج مجموعات البيانات وسجلاتها بصيغة JSON أو CSV من واجهة عامة للقراءة فقط، بلا مفتاح ولا تسجيل.
          </p>
        </div>
      </section>

      <PearlLattice />

      <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <section className="mt-2 max-w-2xl space-y-4 text-sm leading-8 text-ink/80">
          <p>
            الأساس: <Inline wrap>{base}</Inline>. كل الطلبات <Inline>GET</Inline>، والاستجابات JSON بترميز UTF-8، وCORS
            مفتوح لأي موقع (<Inline>Access-Control-Allow-Origin: *</Inline>). تُخزَّن الاستجابات الناجحة مؤقتًا
            عند الحافة خمس دقائق (<Inline>s-maxage=300</Inline>)، فلا تتوقع لحظية تامة؛ وللتحقق من حداثة البيانات استعلم{" "}
            <Inline>/api/freshness</Inline>.
          </p>
          <p>
            البيانات هي نسخة هذا المشروع من{" "}
            <a href="https://data.gov.bh" target="_blank" rel="noopener noreferrer" className={linkClass}>
              data.gov.bh
            </a>{" "}
            (مشروع مستقل غير رسمي)، ويحتفظ كل نص ورقم بصيغته الأصلية. للاستخدام الرسمي أو القانوني ارجع إلى المصدر. كن لطيفًا
            مع الخادم: استخدم <Inline>limit</Inline> الأكبر المسموح بدل آلاف الطلبات الصغيرة، ولا تُعد الطلب نفسه في حلقة ضيقة.
          </p>
        </section>

        <Endpoint id="list" path="/api/v1/datasets" title="قائمة مجموعات البيانات">
          <p>
            نفس محرك البحث في الموقع: يدعم العربية والإنجليزية وعدة كلمات، ويوحّد أشكال الهمزات والتاء المربوطة والأرقام الهندية.
          </p>
          <Params
            rows={[
              ["q", "نص البحث (حتى 100 حرف). كل كلمة يجب أن تظهر في العنوان أو الوصف أو الجهة أو الفئة."],
              ["theme", <>اسم الفئة كما هو تمامًا. القيم الصالحة في <Inline>facets.themes</Inline> بكل استجابة.</>],
              ["publisher", <>معرّف الجهة (slug). القيم الصالحة في <Inline>facets.publishers</Inline>.</>],
              [
                "sort",
                <>
                  <Inline>relevance</Inline> (الافتراضي مع <Inline>q</Inline>) · <Inline>updated</Inline> (الأحدث تعديلًا في المصدر) ·{" "}
                  <Inline>title</Inline> (الافتراضي بلا <Inline>q</Inline>) · <Inline>records</Inline> (الأكثر سجلات).
                </>,
              ],
              [
                "updated_since",
                <>
                  تاريخ ISO 8601 (<Inline>2026-01-31</Inline>، يُقرأ منتصف الليل UTC) أو تاريخ ووقت (<Inline>2026-01-31T08:00:00Z</Inline>
                  ): مجموعات عدّلها المصدر في هذا الوقت أو بعده.
                </>,
              ],
              ["page", "رقم الصفحة، يبدأ من 1."],
              ["limit", `عدد النتائج: من 1 إلى ${API_LIST_MAX_LIMIT} (الافتراضي ${API_LIST_DEFAULT_LIMIT}).`],
            ]}
          />
          <Code>{`curl "${base}/datasets?q=births&sort=updated&limit=2"

{
  "total": 1,
  "page": 1,
  "limit": 2,
  "totalPages": 1,
  "results": [
    {
      "id": "live-births-by-governorate",
      "title": "Live Births by Governorate",
      "titleAr": "المواليد الأحياء حسب المحافظة",
      "theme": "Health",
      "publisher": "Ministry of Health",
      "recordsCount": 44,
      "sourceModified": "2026-01-15T08:00:00.000Z",
      "lastSyncedAt": "2026-02-01T10:00:00.000Z",
      "url": "${SITE_URL}/dataset/live-births-by-governorate",
      "officialUrl": "https://www.data.gov.bh/explore/dataset/live-births-by-governorate/"
    }
  ],
  "facets": { "themes": [...], "publishers": [...] }
}`}</Code>
        </Endpoint>

        <Endpoint id="detail" path="/api/v1/datasets/{id}" title="مجموعة بيانات واحدة">
          <p>
            الوصف نصًا عاديًا، والكلمات المفتاحية والترخيص، وقاموس الحقول (<Inline>fields</Inline>) وإحصاءات كل حقل (<Inline>stats</Inline>
            : نسبة الفراغ، عدد القيم المختلفة، الحد الأدنى والأعلى والمتوسط…). المجموعات التي أزالتها البوابة تُعيد{" "}
            <Inline>removed: true</Inline>؛ والمعرّف غير الموجود <Inline>404</Inline>. المجموعات الجزئية (<Inline>partial: true</Inline>) تخزّن
            أول صفوفها فقط، وعددها في <Inline>storedRecordsCount</Inline>.
          </p>
          <Code>{`curl "${base}/datasets/live-births-by-governorate"`}</Code>
        </Endpoint>

        <Endpoint id="records" path="/api/v1/datasets/{id}/records" title="السجلات">
          <p>
            ترقيم بالمؤشر (keyset) لا بالإزاحة: الصفحة 500 بنفس كلفة الأولى، ولا تتحرك قراءتك إن أضافت مزامنة صفوفًا. تأتي السجلات
            مرتبة بمعرّفها التصاعدي.
          </p>
          <Params
            rows={[
              ["after", <>معرّف السجل الأخير من استجابة سابقة (<Inline>nextAfter</Inline>). غيابه يعني البدء من أول سجل.</>],
              ["limit", `من 1 إلى ${API_RECORDS_MAX_LIMIT} (الافتراضي ${API_RECORDS_DEFAULT_LIMIT}). يُتجاهل مع CSV.`],
              [
                "format",
                <>
                  <Inline>json</Inline> (الافتراضي) أو <Inline>csv</Inline>: بث كل السجلات المتبقية ملفًّا واحدًا بترميز UTF-8 مع BOM ليقرأه Excel
                  بالعربية، والصف الأول أسماء الحقول.
                </>,
              ],
            ]}
          />
          <Code>{`curl "${base}/datasets/live-births-by-governorate/records?limit=2"

{
  "id": "live-births-by-governorate",
  "partial": false,
  "storedRecordsCount": 44,
  "recordsCount": 44,
  "removed": false,
  "limit": 2,
  "count": 2,
  "nextAfter": "1208",
  "next": "${base}/datasets/live-births-by-governorate/records?after=1208&limit=2",
  "records": [
    { "id": "1207", "data": { "year": "2015", "governorate": "Capital", "value": 5000 } },
    { "id": "1208", "data": { "year": "2015", "governorate": "Muharraq", "value": 3000 } }
  ]
}

# تابع حتى يصبح nextAfter فارغًا (null)
curl "${base}/datasets/live-births-by-governorate/records?after=1208&limit=1000"

# أو نزّل الملف كاملًا
curl -OJ "${base}/datasets/live-births-by-governorate/records?format=csv"`}</Code>
          <p>
            أمان الجداول: أي خلية نصية تبدأ بـ <Inline>=</Inline> أو <Inline>+</Inline> أو <Inline>-</Inline> أو <Inline>@</Inline> تُسبق بعلامة اقتباس
            مفردة <Inline>&apos;</Inline> كي لا يُنفّذها Excel أو Sheets كمعادلة؛ أما الأرقام (ومنها السالبة) فتبقى أرقامًا.
          </p>
        </Endpoint>

        <section id="errors" aria-labelledby="errors-heading" className="mt-12 max-w-3xl scroll-mt-6">
          <h2 id="errors-heading" className="font-display text-xl font-bold text-sea-900">
            الأخطاء
          </h2>
          <div className="mt-4 space-y-4 text-sm leading-8 text-ink/80">
            <p>
              الأخطاء JSON دائمًا بالشكل التالي، ولا تتضمن تفاصيل داخلية: <Inline>400</Inline> لقيمة بارامتر غير صالحة (يُسمّى البارامتر في{" "}
              <Inline>parameter</Inline>)، و<Inline>404</Inline> لمجموعة أو فئة أو جهة غير موجودة، و<Inline>500</Inline> لعطل في الخادم.
            </p>
            <Code>{`HTTP/1.1 400 Bad Request

{ "error": "invalid_parameter", "message": "limit must be an integer between 1 and ${API_LIST_MAX_LIMIT}", "parameter": "limit" }`}</Code>
          </div>
        </section>
      </div>
    </>
  );
}
