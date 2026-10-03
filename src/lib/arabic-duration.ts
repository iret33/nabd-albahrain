/**
 * Arabic wording for the durations the About page quotes from the live
 * configuration ("كل 6 ساعات", "لمدة دقيقتين"). Pure.
 *
 * Arabic number agreement is the reason this is not a template string:
 *   1 -> singular        ساعة
 *   2 -> dual            ساعتين
 *   3-10 -> plural       ساعات
 *   11+ -> singular      ساعة
 * Digits are Latin, per the site-wide rule.
 */

interface UnitForms {
  one: string;
  two: string;
  few: string;
  many: string;
}

const UNITS: Record<"second" | "minute" | "hour" | "day", UnitForms> = {
  second: { one: "ثانية", two: "ثانيتين", few: "ثوانٍ", many: "ثانية" },
  minute: { one: "دقيقة", two: "دقيقتين", few: "دقائق", many: "دقيقة" },
  hour: { one: "ساعة", two: "ساعتين", few: "ساعات", many: "ساعة" },
  day: { one: "يوم", two: "يومين", few: "أيام", many: "يومًا" },
};

function counted(n: number, forms: UnitForms): string {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  return `${n} ${n >= 3 && n <= 10 ? forms.few : forms.many}`;
}

/**
 * A span of seconds in its largest exact unit: 120 -> "دقيقتين", 21600 -> "6 ساعات",
 * 90 -> "90 ثانية". Non-positive or non-finite input gives "—".
 */
export function formatSpanAr(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "—";
  const s = Math.round(totalSeconds);
  if (s % 86_400 === 0) return counted(s / 86_400, UNITS.day);
  if (s % 3_600 === 0) return counted(s / 3_600, UNITS.hour);
  if (s % 60 === 0) return counted(s / 60, UNITS.minute);
  return counted(s, UNITS.second);
}

/** "every N ..." for an interval given in minutes: 360 -> "كل 6 ساعات", 60 -> "كل ساعة". */
export function formatEveryAr(minutes: number): string {
  const span = formatSpanAr(minutes * 60);
  return span === "—" ? span : `كل ${span}`;
}
