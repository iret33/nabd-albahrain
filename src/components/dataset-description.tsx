/**
 * The portal's own description of the dataset (methodology, source, caveats),
 * promoted from the bottom of the page to right under the summary line.
 *
 * Short text (< 400 characters) is simply shown, in an open `<details>` that
 * visitors can fold away. Long text starts folded: a three-line clamped
 * preview stays visible and the "show the full description" summary opens the
 * rest. The preview hides itself while the details are open (CSS `:has`), so
 * nothing is read twice. Native `<details>`: no client JS, keyboard and
 * screen-reader support for free.
 *
 * `text` is plain text (the caller strips the portal's HTML first); line
 * breaks are kept. Every paragraph is its own `dir="auto"` block, because
 * descriptions are often English and sometimes bilingual: each paragraph gets
 * its own direction (a final full stop and the clamp's ellipsis stay at the end
 * of the sentence) and `text-right` keeps them on the page's right-hand edge.
 */
export const DESCRIPTION_OPEN_BELOW = 400;

function Chevron() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4 shrink-0 motion-safe:transition-transform group-open:rotate-180"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 8l5 5 5-5" />
    </svg>
  );
}

export function DatasetDescription({ text, className = "" }: { text: string; className?: string }) {
  const clean = text.trim();
  if (!clean) return null;
  const long = clean.length >= DESCRIPTION_OPEN_BELOW;
  const paragraphs = clean
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className={`group/desc max-w-3xl ${className}`}>
      {long && (
        <p
          dir="auto"
          className="line-clamp-3 whitespace-pre-line break-words text-right text-sm leading-7 text-ink/80 group-has-[details[open]]/desc:hidden"
        >
          {paragraphs[0]}
        </p>
      )}
      <details open={!long} className="group mt-1">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg py-1 text-sm font-medium text-sea-900 hover:text-coral [&::-webkit-details-marker]:hidden">
          {long ? (
            <>
              <span className="group-open:hidden">عرض الوصف كاملًا</span>
              <span className="hidden group-open:inline">إخفاء الوصف</span>
            </>
          ) : (
            "عن هذه المجموعة"
          )}
          <Chevron />
        </summary>
        <div className="mt-1 space-y-3">
          {paragraphs.map((paragraph, i) => (
            <p key={i} dir="auto" className="whitespace-pre-line break-words text-right text-sm leading-7 text-ink/80">
              {paragraph}
            </p>
          ))}
        </div>
      </details>
    </div>
  );
}
