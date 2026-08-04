import type { Metadata } from "next";
import Link from "next/link";
import { PearlLattice } from "@/components/pearl-lattice";

export const metadata: Metadata = {
  title: "عن المشروع | نبض البحرين",
  description:
    "نبض البحرين مشروع مستقل غير رسمي يعرض بصريًا بيانات بوابة data.gov.bh المفتوحة لمملكة البحرين — عن المشروع، المصدر، وتكرار التحديث.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-display text-xl font-bold text-sea-900">{title}</h2>
      <div className="mt-3 max-w-2xl space-y-4 text-sm leading-8 text-ink/70">{children}</div>
    </section>
  );
}

export default function AboutPage() {
  return (
    <>
      <section className="bg-sea-900 text-sand-50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <p className="font-display text-sm font-bold tracking-wide text-pearl">عن المشروع</p>
          <h1 className="mt-3 max-w-2xl font-display text-3xl font-black leading-tight sm:text-4xl">
            نبض البحرين
          </h1>
          <p className="mt-4 max-w-xl text-base text-sand-100/80 sm:text-lg">
            لوحة بيانات عربية مستقلة تعيد عرض كل مجموعات البيانات المفتوحة في بوابة data.gov.bh
            الرسمية لمملكة البحرين بشكل بصري وسهل التصفح.
          </p>
        </div>
      </section>

      <PearlLattice />

      <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
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
            <a
              href="https://data.gov.bh"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sea-900 underline decoration-pearl decoration-2 underline-offset-4 transition-colors hover:text-coral"
            >
              بوابة البيانات المفتوحة الرسمية لمملكة البحرين data.gov.bh
            </a>{" "}
            عبر واجهتها البرمجية العامة (Explore API). لا يقوم هذا المشروع بتعديل قيم البيانات
            نفسها — فقط بتنظيمها وعرضها بصريًا. عناوين مجموعات البيانات وأسماء الحقول تبقى كما
            وردت من المصدر دون ترجمة.
          </p>
        </Section>

        <Section title="تكرار التحديث">
          <p>
            تتم مزامنة البيانات مع بوابة data.gov.bh بشكل يومي تلقائيًا. قد يظهر فارق بسيط بين
            وقت نشر تحديث في المصدر الرسمي ووقت ظهوره هنا، حسب توقيت دورة المزامنة اليومية. يظهر
            وقت آخر مزامنة لكل مجموعة بيانات في صفحتها الخاصة.
          </p>
        </Section>

        <Section title="إخلاء مسؤولية">
          <p>
            هذا الموقع أداة عرض واستكشاف فقط، وقد يحتوي على تأخر بسيط في التحديث أو أخطاء غير
            مقصودة أثناء المعالجة. لا يُعتد بالأرقام أو المؤشرات المعروضة هنا كمصدر رسمي أو
            نهائي — الأرقام والبيانات الرسمية والمعتمدة هي فقط ما يُنشر مباشرة على{" "}
            <a
              href="https://data.gov.bh"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sea-900 underline decoration-pearl decoration-2 underline-offset-4 transition-colors hover:text-coral"
            >
              data.gov.bh
            </a>
            . لأي استخدام رسمي أو بحثي أو قانوني، يُرجى دائمًا الرجوع إلى المصدر الأصلي.
          </p>
        </Section>

        <Section title="التواصل">
          <p>
            لأي استفسار أو ملاحظة حول هذا المشروع المستقل (وليس حول بيانات data.gov.bh نفسها، والتي
            تخص الجهات الحكومية الناشرة لها)، يمكن التواصل عبر{" "}
            <a
              href="https://hekkapp.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sea-900 underline decoration-pearl decoration-2 underline-offset-4 transition-colors hover:text-coral"
            >
              hekkapp.com
            </a>
            .
          </p>
        </Section>

        <div className="mt-12 flex flex-wrap gap-3">
          <Link
            href="/categories"
            className="rounded-full bg-sea-900 px-6 py-3 text-sm font-bold text-sand-50 transition-transform hover:scale-105"
          >
            تصفح الفئات
          </Link>
          <Link
            href="/publishers"
            className="rounded-full border border-line-light px-6 py-3 text-sm font-bold text-ink/80 transition-colors hover:border-coral hover:text-coral"
          >
            الجهات الحكومية
          </Link>
        </div>
      </div>
    </>
  );
}
