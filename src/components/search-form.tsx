/**
 * Plain GET form to /search?q= — works with zero client JS (a query-string
 * driven Server Component page on the other end), reused by the site
 * header (compact) and the /search page itself (full width).
 */
export function SearchForm({
  initialQuery = "",
  className = "",
  size = "md",
}: {
  initialQuery?: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const inputPadding = size === "sm" ? "py-1.5 pe-9 ps-3 text-sm" : "py-3 pe-12 ps-4 text-base";
  const buttonSize = size === "sm" ? "h-7 w-7" : "h-9 w-9";

  return (
    <form action="/search" method="GET" role="search" className={`relative ${className}`}>
      <label htmlFor="q" className="sr-only">
        ابحث في مجموعات البيانات
      </label>
      <input
        id="q"
        type="search"
        name="q"
        defaultValue={initialQuery}
        placeholder="ابحث عن مجموعة بيانات، جهة، أو فئة…"
        autoComplete="off"
        className={`w-full rounded-full border border-line-light bg-white text-ink placeholder:text-ink/40 ${inputPadding}`}
      />
      <button
        type="submit"
        aria-label="بحث"
        className={`absolute inset-y-0 end-1.5 my-auto flex ${buttonSize} items-center justify-center rounded-full text-ink/50 transition-colors hover:bg-sand-100 hover:text-coral`}
      >
        <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" aria-hidden="true">
          <circle cx="9" cy="9" r="6.25" stroke="currentColor" strokeWidth="1.6" />
          <path d="M13.5 13.5L17.5 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </form>
  );
}
