/**
 * Placeholder home page — Phase 1 scaffold only.
 * Later phases replace this with the real dashboard (dataset grid, search,
 * theme breakdown, etc.) once the sync engine (Phase 2) populates data.
 * This page exists to prove the design tokens / fonts / RTL layout wire up.
 */
export default function Home() {
  return (
    <>
      <section className="bg-sea-900 text-sand-50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <p className="font-display text-sm font-bold tracking-wide text-pearl">
            نسخة تجريبية أولية
          </p>
          <h1 className="mt-3 max-w-2xl font-display text-3xl font-black leading-tight sm:text-5xl">
            نبض البحرين
          </h1>
          <p className="mt-4 max-w-xl text-base text-sand-100/80 sm:text-lg">
            لوحة بيانات عربية مستقلة تعرض بصريًا كل مجموعات البيانات المفتوحة
            في بوابة data.gov.bh الرسمية لمملكة البحرين. هذه الصفحة عبارة عن
            هيكل أولي — قريبًا ستعرض بيانات حقيقية من أكثر من 35 جهة حكومية.
          </p>

          <dl className="mt-10 flex flex-wrap gap-x-8 gap-y-6 border-t border-line-dark pt-8">
            <div>
              <dt className="text-xs font-medium text-sand-100/60">
                مجموعات البيانات
              </dt>
              <dd className="mt-1 font-display text-3xl font-bold">
                <span dir="ltr" className="tabular-figures inline-block">
                  512+
                </span>
              </dd>
            </div>
            <div className="border-r border-line-dark pr-8">
              <dt className="text-xs font-medium text-sand-100/60">
                الجهات الحكومية
              </dt>
              <dd className="mt-1 font-display text-3xl font-bold">
                <span dir="ltr" className="tabular-figures inline-block">
                  35+
                </span>
              </dd>
            </div>
            <div className="border-r border-line-dark pr-8">
              <dt className="text-xs font-medium text-sand-100/60">الحالة</dt>
              <dd className="mt-1 font-display text-3xl font-bold text-pearl">
                قيد الإنشاء
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <div className="pearl-lattice" aria-hidden="true" />

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="rounded-2xl border border-line-light bg-white p-8 shadow-sm">
          <h2 className="font-display text-xl font-bold text-sea-900">
            المرحلة القادمة
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-ink/70">
            هذا هيكل أولي (Scaffold) للمشروع. المراحل القادمة ستضيف محرك
            المزامنة مع بوابة البيانات المفتوحة، وصفحات تصفح واستكشاف
            مجموعات البيانات، والرسوم البيانية، ولوحة الإدارة.
          </p>
        </div>
      </section>
    </>
  );
}
