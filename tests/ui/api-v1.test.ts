import { describe, expect, it } from "vitest";
import {
  ApiParamError,
  CACHE_PUBLIC,
  CSV_BOM,
  badRequest,
  csvCell,
  csvContentDisposition,
  csvRow,
  jsonError,
  jsonOk,
  notFound,
  parseDatasetId,
  parseDatasetsQuery,
  parseIntParam,
  parseRecordsQuery,
  parseUpdatedSince,
  preflight,
  serverError,
  toDatasetSummary,
} from "@/lib/api-v1";
import { SITE_URL } from "@/lib/site";

const sp = (query: string) => new URLSearchParams(query);

describe("csvCell: formula injection", () => {
  it.each(["=SUM(A1:A9)", "+1+1", "-2+3", "@SUM(A1)", "=cmd|' /C calc'!A0", "\tTABBED", "\rCR"])(
    "neutralizes %j with a leading quote",
    (cell) => {
      const out = csvCell(cell);
      // May be wrapped in double quotes when it also needs RFC 4180 quoting.
      expect(out.replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  it("leaves ordinary text and numbers alone", () => {
    expect(csvCell("Ministry of Health")).toBe("Ministry of Health");
    expect(csvCell("المواليد")).toBe("المواليد");
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("5 - 3")).toBe("5 - 3");
  });

  it("does not turn numbers or plain numeric text into text (negative values stay numeric)", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(-0.25)).toBe("-0.25");
    expect(csvCell(1234.5)).toBe("1234.5");
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell("-3.2e4")).toBe("-3.2e4");
    // ...but anything that is more than a number still is neutralized
    expect(csvCell("-5+SUM(A1)")).toBe("'-5+SUM(A1)");
    expect(csvCell("+966 1234")).toBe("'+966 1234");
  });

  it("neutralizes nested values that serialize to something formula-like", () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell([1, 2])).toBe('"[1,2]"');
  });
});

describe("csvCell: RFC 4180", () => {
  it("quotes cells with commas, quotes and line breaks, doubling quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
  });

  it("renders null/undefined as empty and booleans as words", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(false)).toBe("false");
  });

  it("serializes geo-points as JSON in one quoted cell", () => {
    expect(csvCell({ lon: 50.5, lat: 26.1 })).toBe('"{""lon"":50.5,""lat"":26.1}"');
  });

  it("terminates rows with CRLF and joins with commas", () => {
    expect(csvRow(["a", 1, null, "=x"])).toBe("a,1,,'=x\r\n");
  });

  it("has a UTF-8 BOM constant for Excel", () => {
    expect(CSV_BOM).toBe("\uFEFF");
    expect(new TextEncoder().encode(CSV_BOM)).toEqual(Uint8Array.from([0xef, 0xbb, 0xbf]));
  });

  it("builds a safe Content-Disposition for any id", () => {
    const cd = csvContentDisposition('weird "id"/with\r\nstuff & مجموعة');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd.match(/filename="([^"]*)"/)?.[1]).toMatch(/^[A-Za-z0-9._-]+\.csv$/);
    expect(cd).toContain("filename*=UTF-8''");
    expect(csvContentDisposition("live-births-by-governorate")).toContain('filename="live-births-by-governorate.csv"');
  });
});

describe("parseIntParam", () => {
  const opts = { min: 1, max: 100, def: 30 };
  it("defaults when absent or empty", () => {
    expect(parseIntParam(null, "limit", opts)).toBe(30);
    expect(parseIntParam("", "limit", opts)).toBe(30);
    expect(parseIntParam("  ", "limit", opts)).toBe(30);
  });

  it("accepts integers in range", () => {
    expect(parseIntParam("1", "limit", opts)).toBe(1);
    expect(parseIntParam("100", "limit", opts)).toBe(100);
    expect(parseIntParam(" 25 ", "limit", opts)).toBe(25);
  });

  it.each(["0", "101", "-1", "1.5", "1e2", "abc", "0x10", "99999999999", "Infinity", "NaN", "٣"])(
    "rejects %j naming the parameter",
    (raw) => {
      try {
        parseIntParam(raw, "limit", opts);
        throw new Error("expected a throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiParamError);
        expect((err as ApiParamError).parameter).toBe("limit");
      }
    },
  );
});

describe("parseUpdatedSince", () => {
  it("reads a bare date as 00:00 UTC", () => {
    expect(parseUpdatedSince("2026-01-31")?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  it("reads date-times, with or without a zone (no zone = UTC)", () => {
    expect(parseUpdatedSince("2026-01-31T08:00:00Z")?.toISOString()).toBe("2026-01-31T08:00:00.000Z");
    expect(parseUpdatedSince("2026-01-31T08:00:00")?.toISOString()).toBe("2026-01-31T08:00:00.000Z");
    expect(parseUpdatedSince("2026-01-31T11:00:00+03:00")?.toISOString()).toBe("2026-01-31T08:00:00.000Z");
    expect(parseUpdatedSince("2026-01-31T11:00:00+0300")?.toISOString()).toBe("2026-01-31T08:00:00.000Z");
    expect(parseUpdatedSince("2026-01-31T08:00Z")?.toISOString()).toBe("2026-01-31T08:00:00.000Z");
  });

  it("is null when absent", () => {
    expect(parseUpdatedSince(null)).toBeNull();
    expect(parseUpdatedSince("")).toBeNull();
  });

  it.each(["yesterday", "2026-13-01", "2026-02-31", "2026-1-5", "20260131", "2026-01-31T25:00:00Z", "1700000000", "2026-01-31; DROP TABLE"])(
    "rejects %j",
    (raw) => {
      expect(() => parseUpdatedSince(raw)).toThrow(ApiParamError);
    },
  );
});

describe("parseDatasetsQuery", () => {
  it("applies defaults", () => {
    const q = parseDatasetsQuery(sp(""));
    expect(q.limit).toBe(30);
    expect(q.updatedSince).toBeNull();
    expect(q.list).toMatchObject({ q: "", theme: null, publisher: null, sort: null, page: 1 });
  });

  it("passes valid filters through", () => {
    const q = parseDatasetsQuery(sp("q=live%20births&theme=Health&publisher=ministry-of-health&sort=updated&page=3&limit=100&updated_since=2026-01-01"));
    expect(q.list).toMatchObject({ q: "live births", theme: "Health", publisher: "ministry-of-health", sort: "updated", page: 3 });
    expect(q.limit).toBe(100);
    expect(q.updatedSince?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("accepts Arabic queries and themes", () => {
    const q = parseDatasetsQuery(sp(`q=${encodeURIComponent("المواليد الأحياء")}&theme=${encodeURIComponent("الصحة")}`));
    expect(q.list.q).toBe("المواليد الأحياء");
    expect(q.list.theme).toBe("الصحة");
  });

  it.each([
    ["sort=popularity", "sort"],
    ["limit=101", "limit"],
    ["limit=0", "limit"],
    ["limit=ten", "limit"],
    ["page=0", "page"],
    ["page=1.5", "page"],
    ["page=10001", "page"],
    ["publisher=Ministry%20of%20Health", "publisher"],
    ["publisher=../../etc", "publisher"],
    ["updated_since=soon", "updated_since"],
    [`q=${"x".repeat(101)}`, "q"],
    [`theme=${"x".repeat(101)}`, "theme"],
  ])("rejects %s with a 400 naming %s", (query, parameter) => {
    try {
      parseDatasetsQuery(sp(query));
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiParamError);
      expect((err as ApiParamError).parameter).toBe(parameter);
    }
  });

  it("takes the first value of a repeated parameter", () => {
    expect(parseDatasetsQuery(sp("limit=5&limit=500")).limit).toBe(5);
  });
});

describe("parseRecordsQuery", () => {
  it("applies defaults", () => {
    expect(parseRecordsQuery(sp(""))).toEqual({ after: null, limit: 100, format: "json" });
  });

  it("accepts a keyset cursor, limit up to 1000 and csv (any case)", () => {
    expect(parseRecordsQuery(sp("after=123456789012&limit=1000&format=CSV"))).toEqual({ after: "123456789012", limit: 1000, format: "csv" });
  });

  it.each([
    ["after=abc", "after"],
    ["after=-1", "after"],
    ["after=1.5", "after"],
    ["after=1234567890123456789", "after"],
    ["limit=1001", "limit"],
    ["limit=0", "limit"],
    ["format=xml", "format"],
  ])("rejects %s naming %s", (query, parameter) => {
    try {
      parseRecordsQuery(sp(query));
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiParamError);
      expect((err as ApiParamError).parameter).toBe(parameter);
    }
  });
});

describe("parseDatasetId", () => {
  it("decodes and accepts ordinary ids", () => {
    expect(parseDatasetId("live-births-by-governorate")).toBe("live-births-by-governorate");
    expect(parseDatasetId("a%20b")).toBe("a b");
  });

  it("rejects ids that cannot name a dataset (control chars, empty, absurdly long, bad escapes survive structurally)", () => {
    expect(parseDatasetId("")).toBeNull();
    expect(parseDatasetId("%00")).toBeNull();
    expect(parseDatasetId("a".repeat(300))).toBeNull();
    expect(parseDatasetId("%E0%A4%A")).toBe("%E0%A4%A"); // malformed escape: kept raw, will simply not exist
  });
});

describe("responses", () => {
  it("jsonOk: 200, JSON, CORS open, public cache for CDNs", async () => {
    const res = jsonOk({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe(CACHE_PUBLIC);
    expect(CACHE_PUBLIC).toBe("public, s-maxage=300, stale-while-revalidate=3600");
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("errors are no-store JSON with CORS and never carry internals", async () => {
    const bad = badRequest(new ApiParamError("limit", "limit must be an integer between 1 and 100"));
    expect(bad.status).toBe(400);
    expect(bad.headers.get("cache-control")).toBe("no-store");
    expect(bad.headers.get("access-control-allow-origin")).toBe("*");
    expect(await bad.json()).toEqual({ error: "invalid_parameter", message: "limit must be an integer between 1 and 100", parameter: "limit" });

    const nf = notFound("Dataset");
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "not_found", message: "Dataset not found" });

    const err = serverError();
    expect(err.status).toBe(500);
    expect(JSON.stringify(await err.json())).not.toMatch(/prisma|postgres|select |stack/i);

    expect(jsonError(404, "unknown_theme", "x", { parameter: "theme" }).status).toBe(404);
  });

  it("preflight answers 204 with CORS and no body", async () => {
    const res = preflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(await res.text()).toBe("");
  });
});

describe("toDatasetSummary", () => {
  it("maps a row to the public shape with ISO dates and absolute urls", () => {
    const out = toDatasetSummary({
      id: "live births/2020",
      title: "01 - Live Births",
      titleAr: "المواليد الأحياء",
      theme: "Health",
      publisher: "Ministry of Health",
      recordsCount: 44,
      sourceModified: new Date("2026-01-15T08:00:00Z"),
      lastSyncedAt: "2026-02-01T10:00:00.000Z",
    });
    expect(out).toEqual({
      id: "live births/2020",
      title: "01 - Live Births",
      titleAr: "المواليد الأحياء",
      theme: "Health",
      publisher: "Ministry of Health",
      recordsCount: 44,
      sourceModified: "2026-01-15T08:00:00.000Z",
      lastSyncedAt: "2026-02-01T10:00:00.000Z",
      url: `${SITE_URL}/dataset/live%20births%2F2020`,
      officialUrl: "https://www.data.gov.bh/explore/dataset/live%20births%2F2020/",
    });
  });

  it("returns nulls for missing dates and a blank Arabic title", () => {
    const out = toDatasetSummary({
      id: "x",
      title: "X",
      titleAr: "  ",
      theme: null,
      publisher: null,
      recordsCount: 0,
      sourceModified: null,
      lastSyncedAt: null,
    });
    expect(out.titleAr).toBeNull();
    expect(out.sourceModified).toBeNull();
    expect(out.lastSyncedAt).toBeNull();
  });
});
