import { describe, expect, it } from "vitest";
import { RANK_WEIGHTS, compareByUpdated, compareRanked, scoreMatch, type RankedItem } from "@/lib/ranking";
import { tokenize } from "@/lib/search";

const score = (
  fields: { titles: Array<string | null>; publisher?: string | null; theme?: string | null },
  query: string,
) => scoreMatch({ titles: fields.titles, publisher: fields.publisher ?? null, theme: fields.theme ?? null }, tokenize(query));

describe("scoreMatch", () => {
  it("returns 0 for no tokens", () => {
    expect(scoreMatch({ titles: ["x"], publisher: null, theme: null }, [])).toBe(0);
  });

  it("gives the exact title phrase the largest bonus plus per-token title points", () => {
    const s = score({ titles: ["Live Births by Governorate"] }, "live births");
    expect(s).toBe(RANK_WEIGHTS.phraseInTitle + 2 * RANK_WEIGHTS.tokenInTitle);
  });

  it("counts title tokens without the phrase bonus when words are not adjacent", () => {
    const s = score({ titles: ["Births by governorate (live)"] }, "live births");
    expect(s).toBe(2 * RANK_WEIGHTS.tokenInTitle);
  });

  it("adds publisher/theme points independently of the title", () => {
    const inTitleAndPublisher = score({ titles: ["Health statistics"], publisher: "Ministry of Health" }, "health");
    const inTitleOnly = score({ titles: ["Health statistics"], publisher: "Other" }, "health");
    expect(inTitleAndPublisher - inTitleOnly).toBe(RANK_WEIGHTS.tokenInMeta);
  });

  it("scores a token found nowhere visible as description-only", () => {
    expect(score({ titles: ["Unrelated"], publisher: "P", theme: "T" }, "vaccination")).toBe(
      RANK_WEIGHTS.tokenElsewhere,
    );
  });

  it("ranks title > publisher/theme > description", () => {
    const title = score({ titles: ["Schools by type"] }, "schools");
    const meta = score({ titles: ["Education stats"], publisher: "Schools Authority" }, "schools");
    const desc = score({ titles: ["Education stats"], publisher: "Ministry" }, "schools");
    expect(title).toBeGreaterThan(meta);
    expect(meta).toBeGreaterThan(desc);
  });

  it("normalizes both sides: alef variants, ta marbuta and Arabic-Indic digits", () => {
    const s = score({ titles: ["إحصائيات المدارس ٢٠٢٠"] }, "احصائيات المدارس 2020");
    expect(s).toBe(RANK_WEIGHTS.phraseInTitle + 3 * RANK_WEIGHTS.tokenInTitle);
  });

  it("checks every title variant (Arabic and English)", () => {
    const s = score({ titles: ["Population by Nationality", "السكان حسب الجنسية"] }, "الجنسية");
    expect(s).toBe(RANK_WEIGHTS.phraseInTitle + RANK_WEIGHTS.tokenInTitle);
  });

  it("tolerates null/empty fields", () => {
    expect(score({ titles: [null, ""], publisher: null, theme: null }, "water")).toBe(RANK_WEIGHTS.tokenElsewhere);
  });
});

describe("ordering", () => {
  const d = (s: string) => new Date(s);
  const item = (id: string, scoreValue: number, sourceModified: string | null): RankedItem => ({
    id,
    score: scoreValue,
    sourceModified: sourceModified ? d(sourceModified) : null,
  });

  it("sorts by score, then newest source date, then id", () => {
    const items = [
      item("b", 5, "2026-01-01"),
      item("a", 5, "2026-01-01"),
      item("c", 5, "2026-06-01"),
      item("z", 9, null),
      item("n", 5, null),
    ];
    expect(items.sort(compareRanked).map((i) => i.id)).toEqual(["z", "c", "a", "b", "n"]);
  });

  it("compareByUpdated puts undated rows last and is stable on ties", () => {
    const rows = [
      { id: "2", sourceModified: null },
      { id: "1", sourceModified: d("2020-01-01") },
      { id: "0", sourceModified: d("2020-01-01") },
      { id: "3", sourceModified: d("2021-01-01") },
    ];
    expect(rows.sort(compareByUpdated).map((r) => r.id)).toEqual(["3", "0", "1", "2"]);
  });

  it("is a consistent total order (antisymmetric)", () => {
    const a = item("a", 1, "2026-01-01");
    const b = item("b", 1, "2026-01-01");
    expect(Math.sign(compareRanked(a, b))).toBe(-Math.sign(compareRanked(b, a)));
    expect(compareRanked(a, a)).toBe(0);
  });
});
