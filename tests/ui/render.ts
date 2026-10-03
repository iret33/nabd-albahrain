import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Renders a React element to static HTML inside Vitest (node environment).
 *
 * The repo's tsconfig keeps `"jsx": "preserve"` (Next compiles the JSX), so
 * esbuild turns the components' JSX into classic `React.createElement(...)`
 * calls under Vitest; `React` must therefore exist as a global when they run.
 * Server components without hooks or router context render fine this way, which
 * is enough to assert on the markup (class names, ids, hidden inputs, text).
 */
export function render(element: ReactElement): string {
  (globalThis as { React?: typeof React }).React = React;
  return renderToStaticMarkup(element);
}

/**
 * The markup with tags dropped and whitespace collapsed: what a reader would see.
 * Block-level tags separate words; inline ones (`span`, `bdi`, `a`, `time`) do not,
 * so "«<bdi>cap</bdi>»" reads "«cap»".
 */
export function textOf(html: string): string {
  return html
    .replace(/<\/?(?:p|div|li|ul|ol|th|td|tr|thead|tbody|table|caption|h[1-6]|label|button|form|nav|section|header|footer|main|dt|dd|dl|br|figure|figcaption|details|summary)\b[^>]*>/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
