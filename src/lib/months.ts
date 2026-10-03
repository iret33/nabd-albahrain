/**
 * Month grouping for the "what's new" page. Pure.
 *
 * Months are Bahrain calendar months (UTC+3, no DST), the same zone every date
 * on the site is displayed in: a dataset modified at 22:30 UTC on the 31st is
 * "the 1st" for a reader in Manama, so it must sit under the next month's
 * heading, next to the date printed on its card.
 */

import { DISPLAY_TIME_ZONE } from "@/lib/format";

const keyFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  timeZone: DISPLAY_TIME_ZONE,
});

const labelFormatter = new Intl.DateTimeFormat("ar-BH", {
  year: "numeric",
  month: "long",
  numberingSystem: "latn",
  timeZone: DISPLAY_TIME_ZONE,
});

function toValidDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2026-09" for the Bahrain month containing `date`, or null for a missing/invalid date. */
export function monthKey(date: Date | string | null | undefined): string | null {
  const d = toValidDate(date);
  if (!d) return null;
  const parts = keyFormatter.formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return year && month ? `${year}-${month}` : null;
}

/** Arabic heading for the month of `date`, e.g. "سبتمبر 2026" (Latin digits). */
export function monthLabelAr(date: Date | string | null | undefined): string {
  const d = toValidDate(date);
  return d ? labelFormatter.format(d) : "—";
}

export interface MonthGroup<T> {
  /** "2026-09", or "undated" for items without a usable date. */
  key: string;
  label: string;
  items: T[];
}

/**
 * Groups already-sorted items into consecutive months, keeping their order
 * (the page sorts newest first; this never reorders). Items without a date go
 * into one trailing "undated" group.
 */
export function groupByMonth<T>(items: readonly T[], getDate: (item: T) => Date | string | null | undefined): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = [];
  const index = new Map<string, MonthGroup<T>>();
  const undated: T[] = [];
  for (const item of items) {
    const date = getDate(item);
    const key = monthKey(date);
    if (key === null) {
      undated.push(item);
      continue;
    }
    let group = index.get(key);
    if (!group) {
      group = { key, label: monthLabelAr(date), items: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  if (undated.length > 0) groups.push({ key: "undated", label: "بدون تاريخ", items: undated });
  return groups;
}
