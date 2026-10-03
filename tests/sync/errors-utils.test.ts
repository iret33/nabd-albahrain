import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import {
  CatalogIncompleteError,
  HttpError,
  HttpTimeoutError,
  SyncAbortedError,
  SyncIntegrityError,
  describeError,
} from "@/lib/sync/errors";
import { chunk, fnv1a, mapWithConcurrency, stableStringify } from "@/lib/sync/utils";
import { parseArgs } from "@/lib/sync/cli-args";

describe("describeError: sanitized, classified messages", () => {
  it("never leaks upstream URLs", () => {
    const e = new HttpError("HTTP 503 from https://data.gov.bh/api/explore/v2.1/catalog/datasets?limit=100", 503, "https://data.gov.bh/x");
    const d = describeError(e);
    expect(d.kind).toBe("http");
    expect(d.message).toBe("HTTP 503 from the data.gov.bh portal");
    expect(d.message).not.toMatch(/https?:/);
  });

  it("classifies timeouts, shape errors, database errors and network errors", () => {
    expect(describeError(new HttpTimeoutError("Timed out after 100ms: http://x/y", "http://x/y")).kind).toBe("timeout");

    let zodErr: ZodError | undefined;
    try {
      z.object({ a: z.number() }).parse({ a: "x" });
    } catch (err) {
      zodErr = err as ZodError;
    }
    expect(describeError(zodErr).kind).toBe("shape");
    expect(describeError(new SyntaxError("Unexpected token < in JSON")).kind).toBe("shape");

    const prismaLike = Object.assign(new Error('Invalid `prisma.dataset.update()` invocation: column "x" at db.internal:5432'), {
      name: "PrismaClientKnownRequestError",
      clientVersion: "6.0.0",
    });
    const db = describeError(prismaLike);
    expect(db).toEqual({ kind: "database", message: "Database error" });

    const net = new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    const n = describeError(net);
    expect(n.kind).toBe("network");
    expect(n.message).toContain("ECONNREFUSED");
  });

  it("passes our own integrity/abort messages through (they carry only ids and counts)", () => {
    expect(describeError(new SyncIntegrityError("Export returned 0 rows but the catalog reports 5; keeping previous data"))).toEqual({
      kind: "integrity",
      message: "Export returned 0 rows but the catalog reports 5; keeping previous data",
    });
    expect(describeError(new CatalogIncompleteError("incomplete")).kind).toBe("integrity");
    expect(describeError(new SyncAbortedError("Stopped by SIGTERM")).kind).toBe("aborted");
  });

  it("falls back to a generic message that exposes only the error name", () => {
    const d = describeError(new Error("password=hunter2 host=db.internal"));
    expect(d).toEqual({ kind: "unknown", message: "Unexpected error (Error)" });
    expect(describeError("boom").message).toBe("Unexpected error (string)");
  });
});

describe("mapWithConcurrency", () => {
  it("runs everything with at most N in flight", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async (n) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return n * 2;
      },
      () => -1,
    );
    expect(out).toEqual(Array.from({ length: 12 }, (_, i) => i * 2));
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("clamps a bad concurrency to 1 instead of spawning zero workers", async () => {
    for (const bad of [0, -1, Number.NaN]) {
      const out = await mapWithConcurrency([1, 2, 3], bad, async (n) => n + 1, () => 0);
      expect(out).toEqual([2, 3, 4]);
    }
  });

  it("reports worker errors without stopping the rest", async () => {
    const out = await mapWithConcurrency(
      [1, 2, 3],
      2,
      async (n) => {
        if (n === 2) throw new Error("x");
        return n;
      },
      () => -1,
    );
    expect(out).toEqual([1, -1, 3]);
  });

  it("stops picking up new items once shouldStop() is true", async () => {
    let started = 0;
    const out = await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      1,
      async (n) => {
        started++;
        return n;
      },
      () => -1,
      () => started >= 3,
    );
    expect(started).toBe(3);
    expect(out.filter((v) => v !== undefined)).toEqual([0, 1, 2]);
  });
});

describe("small helpers", () => {
  it("chunk splits with a short tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("stableStringify ignores key order at every depth", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(stableStringify({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("fnv1a is deterministic and 8 hex chars", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
    expect(fnv1a("")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("CLI argument parsing", () => {
  it("accepts the documented flags (and a stray pnpm separator)", () => {
    expect(parseArgs(["--", "--limit", "10", "--dataset", "x", "--force", "--dry-run"])).toEqual({
      limit: 10,
      datasetId: "x",
      force: true,
      dryRun: true,
      recompute: false,
      help: false,
    });
    expect(parseArgs(["--recompute", "--force"]).recompute).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("rejects bad input", () => {
    expect(() => parseArgs(["--limit", "0"])).toThrow();
    expect(() => parseArgs(["--limit", "1.5"])).toThrow();
    expect(() => parseArgs(["--limit"])).toThrow();
    expect(() => parseArgs(["--dataset"])).toThrow();
    expect(() => parseArgs(["--dataset", "--force"])).toThrow();
    expect(() => parseArgs(["--nope"])).toThrow();
    expect(() => parseArgs(["--recompute", "--dry-run"])).toThrow();
    expect(() => parseArgs(["--recompute", "--limit", "3"])).toThrow();
  });
});
