"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "مشاركة الرابط": opens the native share sheet where the browser has one
 * (`navigator.share`, mostly phones), otherwise copies the page address to the
 * clipboard (with a textarea + `execCommand` fallback for insecure contexts and
 * older browsers). The shared address is always the dataset's own URL without
 * the table's sort/search/page query, so a link sent to someone is the clean
 * canonical page.
 *
 * Outcomes are announced in an always-mounted polite live region ("تم نسخ
 * الرابط"), so the button gives feedback to screen-reader users too. The label
 * is the same on every device (it does both jobs), which keeps server and
 * client markup identical: no hydration mismatch and no label flicker.
 */
function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyLinkButton({ title, className = "" }: { title: string; className?: string }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function announce(text: string) {
    setMessage(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), 4000);
  }

  async function onClick() {
    const url = `${window.location.origin}${window.location.pathname}`;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        // Dismissing the sheet is not an error; any other failure falls through to copying.
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      announce("تم نسخ الرابط");
    } catch {
      announce(legacyCopy(url) ? "تم نسخ الرابط" : "تعذّر النسخ — انسخ الرابط من شريط العنوان");
    }
  }

  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-light bg-white px-4 py-2.5 text-sm font-medium text-ink/80 shadow-sm transition-colors hover:border-coral hover:text-coral"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
        </svg>
        مشاركة الرابط
      </button>
      <span role="status" aria-live="polite" className={message ? "text-xs font-medium text-ink/80" : "sr-only"}>
        {message}
      </span>
    </span>
  );
}
