import { describe, expect, it } from "vitest";
import { atomDate, buildAtomFeed, escapeXml, type AtomEntry } from "@/lib/atom";

const base = {
  selfUrl: "https://example.org/feed.xml",
  siteUrl: "https://example.org/updates",
  title: "نبض البحرين — آخر التحديثات",
  author: "نبض البحرين",
};

const entry = (id: string, updated: string | null, extra: Partial<AtomEntry> = {}): AtomEntry => ({
  id: `https://example.org/dataset/${id}`,
  title: `Dataset ${id}`,
  url: `https://example.org/dataset/${id}`,
  updated,
  ...extra,
});

describe("escapeXml", () => {
  it("escapes the five XML specials", () => {
    expect(escapeXml(`Tom & "Jerry" <b>'x'</b>`)).toBe("Tom &amp; &quot;Jerry&quot; &lt;b&gt;&apos;x&apos;&lt;/b&gt;");
  });

  it("escapes & before the others, so entities are not double-escaped wrongly", () => {
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  it("drops characters XML 1.0 cannot represent but keeps tab, newline and Arabic", () => {
    expect(escapeXml("a\u0000b\u000Bc\u001Fd￾e")).toBe("abcde");
    expect(escapeXml("x\ty\nz")).toBe("x\ty\nz");
    expect(escapeXml("المواليد الأحياء")).toBe("المواليد الأحياء");
  });

  it("drops unpaired surrogates but keeps valid pairs (emoji)", () => {
    expect(escapeXml("a\uD83Db")).toBe("ab");
    expect(escapeXml("a\uDE00b")).toBe("ab");
    expect(escapeXml("a😀b")).toBe("a😀b");
  });
});

describe("atomDate", () => {
  it("emits RFC 3339 in UTC without milliseconds", () => {
    expect(atomDate(new Date("2026-09-30T11:05:00.123+03:00"))).toBe("2026-09-30T08:05:00Z");
    expect(atomDate("2026-01-15T08:00:00+00:00")).toBe("2026-01-15T08:00:00Z");
  });

  it("throws on an invalid date rather than printing 'Invalid Date'", () => {
    expect(() => atomDate("nope")).toThrow(RangeError);
  });
});

describe("buildAtomFeed", () => {
  it("orders entries newest first with a stable id tie-break and uses the newest as feed updated", () => {
    const xml = buildAtomFeed({
      ...base,
      entries: [
        entry("b", "2026-03-01T00:00:00Z"),
        entry("a", "2026-03-01T00:00:00Z"),
        entry("new", "2026-09-01T00:00:00Z"),
        entry("old", "2025-01-01T00:00:00Z"),
      ],
    });
    const ids = [...xml.matchAll(/<entry>\s*<id>([^<]+)<\/id>/g)].map((m) => m[1].split("/").pop());
    expect(ids).toEqual(["new", "a", "b", "old"]);
    expect(xml).toMatch(/<\/author>\s*<generator>[^<]*<\/generator>/);
    expect(xml.indexOf("<updated>2026-09-01T00:00:00Z</updated>")).toBeLessThan(xml.indexOf("<entry>"));
  });

  it("caps the entry count after sorting", () => {
    const entries = Array.from({ length: 80 }, (_, i) => entry(`d${String(i).padStart(2, "0")}`, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`));
    expect((buildAtomFeed({ ...base, entries }).match(/<entry>/g) ?? []).length).toBe(50);
    expect((buildAtomFeed({ ...base, entries, limit: 5 }).match(/<entry>/g) ?? []).length).toBe(5);
  });

  it("skips entries with no usable date instead of inventing one", () => {
    const xml = buildAtomFeed({ ...base, entries: [entry("ok", "2026-02-02T00:00:00Z"), entry("none", null), entry("bad", "garbage")] });
    expect((xml.match(/<entry>/g) ?? []).length).toBe(1);
    expect(xml).not.toContain("dataset/none");
  });

  it("escapes every interpolated value (title, summary, author, category, urls)", () => {
    const xml = buildAtomFeed({
      ...base,
      title: `A & B <feed>`,
      entries: [
        entry("x", "2026-02-02T00:00:00Z", {
          title: `Births <2020> & "deaths"`,
          summary: `5 < 6 && 7 > 6\u0000`,
          author: `Ministry of "Health" & Co`,
          category: `Health & Wellbeing`,
          url: `https://example.org/dataset/a?b=1&c=2`,
        }),
      ],
    });
    expect(xml).toContain("<title>A &amp; B &lt;feed&gt;</title>");
    expect(xml).toContain("<title>Births &lt;2020&gt; &amp; &quot;deaths&quot;</title>");
    expect(xml).toContain('<summary type="text">5 &lt; 6 &amp;&amp; 7 &gt; 6</summary>');
    expect(xml).toContain("<name>Ministry of &quot;Health&quot; &amp; Co</name>");
    expect(xml).toContain('<category term="Health &amp; Wellbeing"/>');
    expect(xml).toContain('href="https://example.org/dataset/a?b=1&amp;c=2"');
    // No raw ampersand or angle bracket from data survives outside tags.
    expect(xml.replace(/<[^>]+>/g, "")).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("omits summary and category when absent and declares the Atom namespace and language", () => {
    const xml = buildAtomFeed({ ...base, entries: [entry("x", "2026-02-02T00:00:00Z")] });
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="ar">')).toBe(true);
    expect(xml).not.toContain("<summary");
    expect(xml).not.toContain("<category");
    expect(xml).toContain('<link rel="self" type="application/atom+xml" href="https://example.org/feed.xml"/>');
    expect(xml).toContain("<id>https://example.org/feed.xml</id>");
    expect(xml.endsWith("</feed>\n")).toBe(true);
  });

  it("renders a valid empty feed using the fallback date", () => {
    const xml = buildAtomFeed({ ...base, entries: [], fallbackUpdated: new Date("2026-05-05T05:05:05Z") });
    expect(xml).toContain("<updated>2026-05-05T05:05:05Z</updated>");
    expect(xml).not.toContain("<entry>");
  });
});
