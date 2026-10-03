import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CSV_MAX_ROWS } from "@/lib/api-v1";
import { MAX_RECORDS_PAGE, RECORDS_PAGE_SIZE } from "@/lib/records-query";
import { INSERT_BATCH_SIZE, MAX_ROWS_HARD_CAP, MAX_ROWS_STORED_WHEN_CAPPED } from "@/lib/row-limits";
import { parsePage } from "@/lib/params";

describe("row limits agree between the writer (sync engine) and the readers (CSV export, records pager)", () => {
  const engine = fs.readFileSync(path.join(__dirname, "../../src/lib/sync/engine.ts"), "utf8");

  /**
   * The engine either imports a constant from "@/lib/row-limits" or still declares its own copy; a copy
   * must have the same value, or the export / pager limits silently drift away from what is stored.
   */
  function engineAgrees(name: string, expected: number) {
    const declared = new RegExp(`const ${name}\\s*=\\s*([\\d_]+)`).exec(engine);
    if (declared) return expect(Number(declared[1].replace(/_/g, ""))).toBe(expected);
    const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"@/lib/row-limits"`).test(engine);
    return expect(imported, `${name} is neither declared in engine.ts nor imported from @/lib/row-limits`).toBe(true);
  }

  it("the engine's caps equal the shared ones", () => {
    engineAgrees("MAX_ROWS_HARD_CAP", MAX_ROWS_HARD_CAP);
    engineAgrees("MAX_ROWS_STORED_WHEN_CAPPED", MAX_ROWS_STORED_WHEN_CAPPED);
    engineAgrees("INSERT_BATCH_SIZE", INSERT_BATCH_SIZE);
  });

  it("a dataset stored complete can always be exported complete: the CSV stop is above the engine's cap", () => {
    expect(CSV_MAX_ROWS).toBeGreaterThan(MAX_ROWS_HARD_CAP);
  });

  it("an over-cap dataset keeps fewer rows than the cap (that is what 'partial' means)", () => {
    expect(MAX_ROWS_STORED_WHEN_CAPPED).toBeLessThan(MAX_ROWS_HARD_CAP);
  });

  it("the records pager's page cap reaches the last row of the largest dataset that is stored in full", () => {
    const lastPage = Math.ceil(MAX_ROWS_HARD_CAP / RECORDS_PAGE_SIZE); // 12,000
    expect(MAX_RECORDS_PAGE).toBeGreaterThanOrEqual(lastPage);
    expect(parsePage(String(lastPage), MAX_RECORDS_PAGE)).toBe(lastPage);
    expect(parsePage("12800", MAX_RECORDS_PAGE)).toBe(12_800);
  });

  it("the shared default of parsePage is unchanged (the listings still stop at 10,000)", () => {
    expect(parsePage("99999")).toBe(10_000);
    expect(parsePage("99999", MAX_RECORDS_PAGE)).toBe(99_999);
    // ... and the digit guard still protects the OFFSET arithmetic from absurd values.
    for (const bad of ["100000", "1e21", "Infinity", "-5"]) expect(parsePage(bad, MAX_RECORDS_PAGE)).toBe(1);
  });
});
