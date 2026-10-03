import { describe, expect, it } from "vitest";
import { formatEveryAr, formatSpanAr } from "@/lib/arabic-duration";

describe("formatSpanAr", () => {
  it("uses the dual for exactly two", () => {
    expect(formatSpanAr(120)).toBe("دقيقتين");
    expect(formatSpanAr(7200)).toBe("ساعتين");
    expect(formatSpanAr(172_800)).toBe("يومين");
    expect(formatSpanAr(2)).toBe("ثانيتين");
  });

  it("uses the singular for one", () => {
    expect(formatSpanAr(60)).toBe("دقيقة");
    expect(formatSpanAr(3600)).toBe("ساعة");
    expect(formatSpanAr(86_400)).toBe("يوم");
  });

  it("uses the plural for 3-10 and the singular accusative for 11+", () => {
    expect(formatSpanAr(600)).toBe("10 دقائق");
    expect(formatSpanAr(180)).toBe("3 دقائق");
    expect(formatSpanAr(6 * 3600)).toBe("6 ساعات");
    expect(formatSpanAr(12 * 3600)).toBe("12 ساعة");
    expect(formatSpanAr(3 * 86_400)).toBe("3 أيام");
    expect(formatSpanAr(30 * 86_400)).toBe("30 يومًا");
    expect(formatSpanAr(15 * 60)).toBe("15 دقيقة");
  });

  it("falls back to seconds when the value is not a whole minute", () => {
    expect(formatSpanAr(90)).toBe("90 ثانية");
    expect(formatSpanAr(45)).toBe("45 ثانية");
  });

  it("is a dash for nonsense", () => {
    expect(formatSpanAr(0)).toBe("—");
    expect(formatSpanAr(-5)).toBe("—");
    expect(formatSpanAr(Number.NaN)).toBe("—");
    expect(formatSpanAr(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("never prints Arabic-Indic digits", () => {
    expect(formatSpanAr(21 * 3600)).not.toMatch(/[٠-٩]/);
  });
});

describe("formatEveryAr", () => {
  it("prefixes 'every'", () => {
    expect(formatEveryAr(360)).toBe("كل 6 ساعات");
    expect(formatEveryAr(60)).toBe("كل ساعة");
    expect(formatEveryAr(1440)).toBe("كل يوم");
    expect(formatEveryAr(30)).toBe("كل 30 دقيقة");
    expect(formatEveryAr(0)).toBe("—");
  });
});
