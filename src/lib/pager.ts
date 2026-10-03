/**
 * Which page links a windowed pager shows. Pure.
 *
 * Shape: `1 … p-1 p p+1 … N`. The window is always 7 slots wide when there are
 * more than 7 pages, so the pager does not change width as you page (near an
 * edge it shows five consecutive pages instead of the ellipsis on that side).
 * `"gap"` is an ellipsis.
 */
export type PageSlot = number | "gap";

export function pageWindow(page: number, totalPages: number): PageSlot[] {
  const total = Number.isSafeInteger(totalPages) && totalPages > 0 ? totalPages : 1;
  const current = Math.min(Math.max(Number.isSafeInteger(page) ? page : 1, 1), total);

  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, "gap", total];
  if (current >= total - 3) return [1, "gap", total - 4, total - 3, total - 2, total - 1, total];
  return [1, "gap", current - 1, current, current + 1, "gap", total];
}

/** Pages beyond this show a "go to page" box: clicking through 10+ pages gets tedious. */
export const JUMP_FORM_MIN_PAGES = 10;
