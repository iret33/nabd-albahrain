import Link from "next/link";

export function Breadcrumb({ theme }: { theme: string | null }) {
  return (
    <nav aria-label="مسار التنقل" className="text-sm text-ink/60">
      <ol className="flex flex-wrap items-center gap-2">
        <li>
          <Link href="/" className="rounded transition-colors hover:text-coral">
            الرئيسية
          </Link>
        </li>
        {theme && (
          <>
            <li aria-hidden="true">/</li>
            <li>
              <Link href={`/categories/${encodeURIComponent(theme)}`} className="rounded transition-colors hover:text-coral">
                {theme}
              </Link>
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}
