import { useId } from "react";
import { MAX_QUERY_LENGTH } from "@/lib/list-query";

type Size = "sm" | "md" | "lg";

const INPUT_CLASS: Record<Size, string> = {
  sm: "h-11 pe-12 ps-4 text-sm",
  md: "h-12 pe-14 ps-5 text-base",
  lg: "h-14 pe-16 ps-6 text-base sm:text-lg",
};

const BUTTON_CLASS: Record<Size, string> = {
  sm: "h-11 w-11 rounded-full text-ink-muted hover:bg-sand-100 hover:text-coral",
  md: "h-12 w-12 rounded-full text-ink-muted hover:bg-sand-100 hover:text-coral",
  // On the hero the button is the one call to action: a sea pill with a pearl glass.
  lg: "m-1.5 h-11 w-11 rounded-full bg-sea-900 text-pearl hover:bg-sea-800 sm:h-12 sm:w-12",
};

/**
 * Plain GET form to /search?q= — works with zero client JS (a query-string
 * driven Server Component page on the other end), reused by the site header
 * (compact), the hero, and the /search page itself.
 *
 * Several of these can be on one page (header + hero/page body), so:
 *  - the input/label ids come from `useId()` and never collide;
 *  - each form is its own `role="search"` landmark and must be told apart by
 *    `label` (the header says "بحث في الموقع", the page body "ابحث في مجموعات
 *    البيانات"); landmarks of the same role need distinct names.
 * `hidden` carries extra GET fields (e.g. keep a theme filter while re-searching).
 * Sizes are all >= 44px tall: this is the primary action of the whole site.
 */
export function SearchForm({
  initialQuery = "",
  className = "",
  size = "md",
  label = "البحث في مجموعات البيانات",
  action = "/search",
  hidden,
  placeholder = "ابحث عن مجموعة بيانات، جهة، أو فئة…",
}: {
  initialQuery?: string;
  className?: string;
  size?: Size;
  /** Accessible name of the search landmark; also the visually hidden input label. */
  label?: string;
  action?: string;
  hidden?: Record<string, string>;
  placeholder?: string;
}) {
  const inputId = useId();

  return (
    <form action={action} method="GET" role="search" aria-label={label} className={`relative ${className}`}>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      {hidden &&
        Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <input
        id={inputId}
        type="search"
        name="q"
        defaultValue={initialQuery}
        placeholder={placeholder}
        maxLength={MAX_QUERY_LENGTH}
        autoComplete="off"
        enterKeyHint="search"
        className={`w-full rounded-full border border-ink/55 bg-white text-ink placeholder:text-ink-muted ${INPUT_CLASS[size]}`}
      />
      <button
        type="submit"
        aria-label="بحث"
        className={`absolute inset-y-0 end-0 my-auto flex items-center justify-center transition-colors ${BUTTON_CLASS[size]}`}
      >
        <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" aria-hidden="true">
          <circle cx="9" cy="9" r="6.25" stroke="currentColor" strokeWidth="1.6" />
          <path d="M13.5 13.5L17.5 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </form>
  );
}
