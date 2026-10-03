/**
 * URL contract of /updates ("what's new"): `?days=7|30|90` limits the window to
 * datasets the SOURCE modified within that many days; no `days` means all time,
 * newest first; `?page=N` pages through it. Pure.
 *
 * (`since` is not reused: on the listing pages it already means 30d|1y, a
 * different vocabulary, and a "what's new" URL should read in plain days.)
 */

import { first, parsePage } from "@/lib/params";

export const UPDATE_WINDOWS = ["7", "30", "90"] as const;
export type UpdateWindow = (typeof UPDATE_WINDOWS)[number] | "all";

export const UPDATE_WINDOW_LABELS: Record<UpdateWindow, string> = {
  "7": "آخر 7 أيام",
  "30": "آخر 30 يومًا",
  "90": "آخر 90 يومًا",
  all: "كل التحديثات",
};

type Raw = string | string[] | undefined | null;

/** The window named by `days`, "all" for absent or anything unrecognized (never throws). */
export function parseUpdateWindow(value: Raw): UpdateWindow {
  const raw = first(value)?.trim();
  return (UPDATE_WINDOWS as readonly string[]).includes(raw ?? "") ? (raw as UpdateWindow) : "all";
}

/** The `sinceDays` argument of `getRecentlyUpdated` for a window. */
export function windowDays(window: UpdateWindow): number | null {
  return window === "all" ? null : Number(window);
}

/** `/updates` plus only the non-default params (`days` unless all, `page` unless 1). */
export function updatesHref(window: UpdateWindow, page = 1): string {
  const qs = new URLSearchParams();
  if (window !== "all") qs.set("days", window);
  const p = parsePage(String(page));
  if (p > 1) qs.set("page", String(p));
  const text = qs.toString();
  return text ? `/updates?${text}` : "/updates";
}

/** Parse both params of the page at once. */
export function parseUpdatesParams(sp: { days?: Raw; page?: Raw } | null | undefined): { window: UpdateWindow; page: number } {
  return { window: parseUpdateWindow(sp?.days), page: parsePage(sp?.page) };
}
