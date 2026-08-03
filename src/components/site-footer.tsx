/**
 * Shared site footer. Every page must show this exact attribution line
 * (per project spec) crediting the official data.gov.bh portal — this
 * project is an independent, unofficial mirror/visualization of it.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-line-light bg-sand-100">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <p className="text-center text-sm text-ink/70 sm:text-start">
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
