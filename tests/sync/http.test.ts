import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// syncConfig is read when http.ts is first imported: make retries fast.
process.env.SYNC_DELAY_MS = "0";
process.env.SYNC_RETRY_BASE_MS = "5";

type Http = typeof import("@/lib/sync/http");
let lib: Http;
let server: http.Server;
let base: string;
const counters = { flaky: 0, always500: 0, notfound: 0, retryAfter: 0 };
const retryAfterStamps: number[] = [];

beforeAll(async () => {
  lib = await import("@/lib/sync/http");
  server = http.createServer((req, res) => {
    const p = req.url ?? "";
    if (p === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ hello: "world" }));
    }
    if (p === "/flaky") {
      counters.flaky++;
      if (counters.flaky < 3) {
        res.writeHead(500);
        return res.end("nope");
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("[1,2,3]");
    }
    if (p === "/always500") {
      counters.always500++;
      res.writeHead(503);
      return res.end("down");
    }
    if (p === "/missing") {
      counters.notfound++;
      res.writeHead(404);
      return res.end("{}");
    }
    if (p === "/retry-after") {
      counters.retryAfter++;
      retryAfterStamps.push(Date.now());
      if (counters.retryAfter === 1) {
        res.writeHead(429, { "retry-after": "1" });
        return res.end("slow down");
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }
    if (p === "/stalled-body") {
      // Headers arrive immediately, the body never completes: the old client
      // cleared its timer right after the headers and hung on res.json().
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
      return undefined;
    }
    if (p === "/trickle") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
      const t = setInterval(() => res.write("1,"), 20);
      res.on("close", () => clearInterval(t));
      return undefined;
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("politeFetchJson", () => {
  it("returns parsed JSON", async () => {
    expect(await lib.politeFetchJson(`${base}/ok`)).toEqual({ hello: "world" });
  });

  it("retries 5xx and succeeds", async () => {
    expect(await lib.politeFetchJson(`${base}/flaky`)).toEqual([1, 2, 3]);
    expect(counters.flaky).toBe(3);
  });

  it("gives up after 2 retries with an HttpError carrying the status", async () => {
    await expect(lib.politeFetchJson(`${base}/always500`)).rejects.toMatchObject({ name: "HttpError", status: 503 });
    expect(counters.always500).toBe(3);
  });

  it("does not retry a 4xx", async () => {
    await expect(lib.politeFetchJson(`${base}/missing`)).rejects.toMatchObject({ name: "HttpError", status: 404 });
    expect(counters.notfound).toBe(1);
  });

  it("honours Retry-After", async () => {
    const t0 = Date.now();
    expect(await lib.politeFetchJson(`${base}/retry-after`)).toEqual({ ok: true });
    // base backoff is 5ms; only Retry-After: 1 explains a >= ~1s gap
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(counters.retryAfter).toBe(2);
  });

  it("times out a stalled BODY (the timer covers more than the headers)", async () => {
    const t0 = Date.now();
    await expect(lib.politeFetchJson(`${base}/stalled-body`, { timeoutMs: 150 })).rejects.toMatchObject({
      name: "HttpTimeoutError",
    });
    // two attempts of 150ms (one retry for timeouts), then it must give up
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("times out a trickling body that never ends", async () => {
    await expect(lib.politeFetchJson(`${base}/trickle`, { timeoutMs: 200 })).rejects.toMatchObject({
      name: "HttpTimeoutError",
    });
  });

  it("aborts an in-flight request when the signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(
      lib.politeFetchJson(`${base}/stalled-body`, { timeoutMs: 10_000, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "SyncAbortedError" });
  });

  it("does not even start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = counters.flaky;
    await expect(lib.politeFetchJson(`${base}/flaky`, { signal: controller.signal })).rejects.toMatchObject({
      name: "SyncAbortedError",
    });
    expect(counters.flaky).toBe(before);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses seconds and HTTP dates, caps, and ignores junk", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(lib.parseRetryAfterMs("5", now)).toBe(5000);
    expect(lib.parseRetryAfterMs("0", now)).toBe(0);
    expect(lib.parseRetryAfterMs("100000", now, 60_000)).toBe(60_000);
    expect(lib.parseRetryAfterMs("Sat, 03 Oct 2026 12:00:10 GMT", now)).toBe(10_000);
    expect(lib.parseRetryAfterMs("Sat, 03 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(lib.parseRetryAfterMs("soon", now)).toBeNull();
    expect(lib.parseRetryAfterMs("-5", now)).toBeNull();
    expect(lib.parseRetryAfterMs(null, now)).toBeNull();
  });
});

describe("RateLimiter", () => {
  it("clamps a bad concurrency instead of queueing forever", async () => {
    for (const bad of [0, -3, Number.NaN]) {
      const limiter = new lib.RateLimiter(bad, 0);
      expect(await limiter.run(async () => "ran")).toBe("ran");
    }
  });

  it("never exceeds the concurrency cap", async () => {
    const limiter = new lib.RateLimiter(2, 0);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
