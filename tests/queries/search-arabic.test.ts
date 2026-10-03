import { describe, expect, it } from "vitest";
import { buildSearchText, htmlToSearchText, normalizeSearch, stripArabicPrefix, tokenize } from "@/lib/search";
import { scoreMatch } from "@/lib/ranking";

/**
 * Real Bahrain open-data titles (data.gov.bh): the stored side is `buildSearchText([...])`, the query side
 * is `tokenize(q)`, and the SQL is `searchText LIKE '%token%'`, i.e. a substring test. `finds` replays it.
 */
const TITLES = {
  airport: "بمطار البحرين الدولي", // "at Bahrain International Airport"
  seaport: "بميناء خليفة بن سلمان", // "at Khalifa Bin Salman Port"
  factories: "المصانع المرخصة", // "the licensed factories"
  census: "نتائج تعداد السكان 2021", // "Population census 2021 results"
  births: "المواليد الأحياء حسب المحافظة", // "Live births by governorate"
  ministry: "وزارة الصحة", // "Ministry of Health"
  electricity: "استهلاك الكهرباء والماء", // "Electricity and water consumption"
  bank: "بنك البحرين المركزي", // "Central Bank of Bahrain"
} as const;

function finds(query: string, title: string): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0) return false;
  const stored = buildSearchText([title]);
  return tokens.every((t) => stored.includes(t));
}

describe("stripArabicPrefix", () => {
  it.each([
    ["المطار", "مطار"],
    ["وبالمطار", "وبالمطار"], // two stacked clitics are not one of the listed forms: left alone, never half-stripped
    ["بالمطار", "مطار"],
    ["للمطار", "مطار"],
    ["والمطار", "مطار"],
    ["فالمطار", "مطار"],
    ["كالمطار", "مطار"],
  ])("%s -> %s", (word, expected) => {
    expect(stripArabicPrefix(word)).toBe(expected);
  });

  it("keeps a word whose remainder would be shorter than three letters", () => {
    expect(stripArabicPrefix("الله")).toBe("الله"); // not "له"
    expect(stripArabicPrefix("ال")).toBe("ال");
    expect(stripArabicPrefix("الف")).toBe("الف");
    expect(stripArabicPrefix("والي")).toBe("والي");
    expect(stripArabicPrefix("للع")).toBe("للع");
  });

  it("strips once, never repeatedly", () => {
    expect(stripArabicPrefix("الالمنيوم")).toBe("المنيوم");
  });

  it("does NOT strip a bare one-letter prefix: those begin real words", () => {
    for (const word of ["وزاره", "بحرين", "بنك", "لجنه", "كهرباء", "كتاب", "فندق", "ميناء", "مطار"]) {
      expect(stripArabicPrefix(word), word).toBe(word);
    }
  });

  it("leaves Latin and digits alone", () => {
    for (const word of ["alpha", "allergy", "2021", "bank"]) expect(stripArabicPrefix(word)).toBe(word);
  });
});

describe("tokenize: Arabic prefixes (R5-07)", () => {
  it("strips the article and clitics from query tokens", () => {
    expect(tokenize("المطار")).toEqual(["مطار"]);
    expect(tokenize("بالمطار")).toEqual(["مطار"]);
    expect(tokenize("للمطار")).toEqual(["مطار"]);
    expect(tokenize("الوزارة")).toEqual(["وزاره"]); // ة folded to ه first
    expect(tokenize("التعداد 2021")).toEqual(["تعداد", "2021"]);
  });

  it("dedupes AFTER stripping", () => {
    expect(tokenize("مطار المطار")).toEqual(["مطار"]);
    expect(tokenize("المطار بالمطار للمطار")).toEqual(["مطار"]);
  });

  it("keeps 'الله' and 'ال' as they are", () => {
    expect(tokenize("الله")).toEqual(["الله"]);
    expect(tokenize("ال")).toEqual(["ال"]);
  });

  it("keeps the one-digit exception and the six-token cap", () => {
    expect(tokenize("المطار 5")).toEqual(["مطار", "5"]);
    expect(tokenize("المطار الميناء الوزارة التعداد الكهرباء الماء المصانع").length).toBe(6);
  });

  it("folds the Persian letter forms so a query typed on a Persian layout finds Arabic titles", () => {
    expect(normalizeSearch("موالید")).toBe(normalizeSearch("مواليد"));
    expect(normalizeSearch("کهرباء")).toBe(normalizeSearch("كهرباء"));
    expect(tokenize("موالید")).toEqual(["مواليد"]);
  });
});

describe("Arabic search end to end (query token vs stored searchText)", () => {
  it("المطار now finds the title that says بمطار, like مطار always did", () => {
    expect(finds("مطار", TITLES.airport)).toBe(true);
    expect(finds("المطار", TITLES.airport)).toBe(true);
    expect(finds("بالمطار", TITLES.airport)).toBe(true);
    expect(finds("للمطار", TITLES.airport)).toBe(true);
  });

  it.each([
    ["الميناء", "seaport"],
    ["ميناء", "seaport"],
    ["الوزارة", "ministry"],
    ["وزارة", "ministry"],
    ["التعداد", "census"],
    ["التعداد 2021", "census"],
    ["تعداد السكان", "census"],
    ["السكان", "census"],
    ["الكهرباء", "electricity"],
    ["الماء", "electricity"],
    ["المصانع", "factories"],
    ["المواليد", "births"],
    ["موالید", "births"], // Persian yeh
    ["البنك", "bank"],
    ["المحافظة", "births"],
  ] as const)("%s finds the %s title", (query, key) => {
    expect(finds(query, TITLES[key])).toBe(true);
  });

  it("does not turn the prefix into a wildcard for unrelated titles", () => {
    expect(finds("المطار", TITLES.seaport)).toBe(false);
    expect(finds("الوزارة", TITLES.bank)).toBe(false);
    expect(finds("التعداد", TITLES.births)).toBe(false);
  });

  it("المصنع (a broken plural of the title's word) is out of scope: no stemming is attempted", () => {
    expect(finds("المصنع", TITLES.factories)).toBe(false);
  });

  it("the stored side is untouched by the query-side stripping (rows indexed before this change still match)", () => {
    expect(buildSearchText([TITLES.airport])).toBe("بمطار البحرين الدولي");
    expect(buildSearchText([TITLES.births])).toContain("المواليد");
  });
});

describe("ranking keeps the phrase bonus for a prefixed phrase", () => {
  const score = (title: string, query: string) =>
    scoreMatch({ titles: [title], publisher: null, theme: null }, tokenize(query));

  it("'تعداد السكان' still earns phrase (10) + two title tokens (5 + 5) on the census title", () => {
    expect(score(TITLES.census, "تعداد السكان")).toBe(20);
  });

  it("... exactly what it earns when the title carries no article at all", () => {
    expect(score("نتائج تعداد سكان 2021", "تعداد السكان")).toBe(20);
  });

  it("a title that only has the words apart ranks below one with the phrase", () => {
    const phrase = score(TITLES.census, "تعداد السكان");
    const apart = score("السكان حسب نتائج التعداد", "تعداد السكان");
    expect(apart).toBe(10); // two title tokens, no phrase
    expect(phrase).toBeGreaterThan(apart);
  });

  it("a prefixed phrase in the middle of a longer query is found too", () => {
    expect(score("احصاءات المواليد الاحياء 2020", "المواليد الأحياء")).toBe(20);
  });

  it("the single-word and Latin cases are unchanged", () => {
    expect(score("Population census", "population")).toBe(15);
    expect(score(TITLES.airport, "المطار")).toBe(15); // phrase + token
  });
});

describe("htmlToSearchText / buildSearchText: markup is not indexed (R2-08)", () => {
  const description =
    '<div class="x"><p style="color:red">Rainfall <strong>data</strong> <a href="https://www.data.gov.bh/x">link</a>&nbsp;here</p><br/><table><tr><td>a</td></tr></table>';
  const stored = buildSearchText(["Rainfall", description]);

  it.each(["href", "style", "color", "strong", "https", "table", "div", "class", "nbsp", "tr", "td"])(
    "the word %s is not in searchText",
    (word) => {
      expect(stored.split(" ")).not.toContain(word);
    },
  );

  it("the visible text is still there", () => {
    for (const word of ["rainfall", "data", "link", "here"]) expect(stored.split(" ")).toContain(word);
  });

  it("matches the documented result for the reviewer's repro", () => {
    expect(buildSearchText([description])).toBe("rainfall data link here a");
  });

  it("keeps words apart across block tags a display stripper would glue together", () => {
    expect(buildSearchText(["<li>Rainfall</li><li>Temperature</li>"])).toBe("rainfall temperature");
    expect(buildSearchText(["<td>Rain</td><td>Wind</td>"])).toBe("rain wind");
  });

  it("decodes numeric entities (Arabic letters) and drops unknown named ones", () => {
    expect(buildSearchText(["&#1575;&#1604;&#1605;&#1591;&#1575;&#1585;"])).toBe(normalizeSearch("المطار"));
    expect(buildSearchText(["&#x627;&#x644;&#x645;&#x637;&#x627;&#x631;"])).toBe(normalizeSearch("المطار"));
    expect(buildSearchText(["caf&eacute; au lait"])).toBe("caf au lait");
    expect(buildSearchText(["a &ndash; b &laquo;c&raquo;"])).toBe("a b c");
  });

  it("survives hostile entities: out of range, surrogates, controls, prototype names", () => {
    expect(buildSearchText(["x&#0;y&#1114112;z&#xD800;w&#9999999;v"])).toBe("x y z w v");
    expect(buildSearchText(["a&constructor;b&toString;c&hasOwnProperty;d&valueOf;e"])).toBe("a b c d e");
  });

  it("a double-encoded &amp;nbsp; leaves no 'nbsp' token", () => {
    expect(buildSearchText(["a&amp;nbsp;b"])).toBe("a b");
  });

  it("drops <style> and <script> bodies and comments entirely", () => {
    expect(buildSearchText(["before<style>.x{color:red}</style>after"])).toBe("before after");
    expect(buildSearchText(["a<script>alert(1)</script>b<!-- hidden note -->c"])).toBe("a b c");
  });

  it("leaves plain-text angle brackets alone: a tag must start with a letter, / or !", () => {
    expect(buildSearchText(["5 < 6 and 7 > 4"])).toBe("5 6 and 7 4");
    expect(buildSearchText(["Rate <5% growth"])).toBe("rate 5 growth");
  });

  it("is a no-op for text without markup, and copes with unterminated markup", () => {
    expect(htmlToSearchText("plain text")).toBe("plain text");
    expect(buildSearchText(['<div class="x'])).toBe("div class x"); // not a tag: no closing '>'
    expect(htmlToSearchText("<script ".repeat(5000)).length).toBeGreaterThan(0);
  });

  it("is linear on pathological input (a pile of unclosed openers)", () => {
    const started = performance.now();
    htmlToSearchText("<script ".repeat(20_000) + "</script");
    htmlToSearchText("<!-- ".repeat(20_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("does not touch the QUERY side: a user may type angle brackets", () => {
    expect(tokenize("<script>")).toEqual(["script"]);
    expect(normalizeSearch("a<b")).toBe("a b");
  });

  it("title, publisher and keywords parts are cleaned the same way", () => {
    expect(buildSearchText(["<b>Health</b>", ["<i>kw</i>"], "Ministry &amp; Co"])).toBe("health kw ministry co");
  });

  it("changing only the markup of a description changes nothing, but changing its text does (rewrite detection)", () => {
    const a = buildSearchText(["T", "<p>rainfall</p>"]);
    const b = buildSearchText(["T", "<div><span>rainfall</span></div>"]);
    const c = buildSearchText(["T", "<p>snowfall</p>"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
