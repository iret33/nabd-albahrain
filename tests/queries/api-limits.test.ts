import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_CSV_BUDGET,
  API_READ_BUDGET,
  CSV_MAX_CONCURRENT,
  CSV_MAX_PER_CLIENT,
  UNKNOWN_CLIENT_FACTOR,
  acquireCsvSlot,
  csvStreamsInFlight,
  guardApi,
  wantsCsv,
} from "@/lib/api-limits";

/** A request from `ip` (clientKey trusts the header only when TRUST_PROXY=1, set below). */
const from = (ip: string | null, url = "https://x.test/api/v1/datasets") =>
  new Request(url, { headers: ip ? { "cf-connecting-ip": ip } : {} });

// Rate-limit buckets live on globalThis for the whole test process, so each test uses addresses of its own.
let n = 0;
const fresh = () => `203.0.113.${++n}`;

const held: Array<() => void> = [];
function acquire(ip: string, now?: number) {
  const slot = acquireCsvSlot(from(ip), now);
  if (!(slot instanceof Response)) held.push(slot.release);
  return slot;
}

beforeEach(() => {
  vi.stubEnv("TRUST_PROXY", "1");
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  while (held.length) held.pop()?.();
  vi.unstubAllEnvs();
});

describe("wantsCsv", () => {
  it("reads format=csv case-insensitively and nothing else", () => {
    expect(wantsCsv(new URLSearchParams("format=csv"))).toBe(true);
    expect(wantsCsv(new URLSearchParams("format=CSV "))).toBe(true);
    expect(wantsCsv(new URLSearchParams("format=json"))).toBe(false);
    expect(wantsCsv(new URLSearchParams(""))).toBe(false);
  });
});

describe("guardApi: per-client request budget", () => {
  it("lets a client make its budget and then answers 429 with Retry-After, no-store and CORS", async () => {
    const ip = fresh();
    const now = 1_000_000;
    for (let i = 0; i < API_READ_BUDGET.limit; i++) expect(guardApi(from(ip), "read", now)).toBeNull();
    const refused = guardApi(from(ip), "read", now + 1000);
    expect(refused).not.toBeNull();
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(refused?.headers.get("cache-control")).toBe("no-store");
    expect(refused?.headers.get("access-control-allow-origin")).toBe("*");
    expect(await refused?.json()).toMatchObject({ error: "rate_limited" });
    // The window passes and the client is welcome again.
    expect(guardApi(from(ip), "read", now + API_READ_BUDGET.windowMs + 1)).toBeNull();
  });

  it("budgets are per client: one client's flood does not touch another", () => {
    const flooder = fresh();
    const bystander = fresh();
    const now = 2_000_000;
    for (let i = 0; i < API_READ_BUDGET.limit + 5; i++) guardApi(from(flooder), "read", now);
    expect(guardApi(from(flooder), "read", now)?.status).toBe(429);
    expect(guardApi(from(bystander), "read", now)).toBeNull();
  });

  it("a CSV request is refused up front once the CSV budget is spent, even with read budget left", () => {
    const ip = fresh();
    const now = 3_000_000;
    // Spend the CSV budget by starting exports (counted by acquireCsvSlot, released at once).
    for (let i = 0; i < API_CSV_BUDGET.limit; i++) {
      const slot = acquireCsvSlot(from(ip), now);
      expect(slot).not.toBeInstanceOf(Response);
      (slot as { release: () => void }).release();
    }
    expect(guardApi(from(ip), "csv", now)?.status).toBe(429);
    expect(guardApi(from(ip), "read", now)).toBeNull(); // plain reads are a different, larger budget
  });

  it("a CSV request that is rejected before it starts does not burn the CSV budget", () => {
    const ip = fresh();
    const now = 4_000_000;
    // guardApi alone (a request that then fails validation) only PEEKS at the CSV budget.
    for (let i = 0; i < API_CSV_BUDGET.limit * 3; i++) expect(guardApi(from(ip), "csv", now + i)).toBeNull();
  });
});

describe("acquireCsvSlot: concurrent exports", () => {
  it("lets one client run CSV_MAX_PER_CLIENT at once and answers 429 for the next", async () => {
    const ip = fresh();
    for (let i = 0; i < CSV_MAX_PER_CLIENT; i++) expect(acquire(ip)).not.toBeInstanceOf(Response);
    const refused = acquire(ip);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(429);
    expect((refused as Response).headers.get("retry-after")).toBeTruthy();
    expect((refused as Response).headers.get("cache-control")).toBe("no-store");
    expect(await (refused as Response).json()).toMatchObject({ error: "rate_limited" });
  });

  it("a finished export gives its slot back to the client", () => {
    const ip = fresh();
    const a = acquire(ip) as { release: () => void };
    acquire(ip);
    expect(acquire(ip)).toBeInstanceOf(Response);
    a.release();
    expect(acquire(ip)).not.toBeInstanceOf(Response);
  });

  it("answers 503 (the server's fault, not the client's) when every slot is taken by OTHER clients", async () => {
    const base = csvStreamsInFlight();
    const fillers = Math.ceil((CSV_MAX_CONCURRENT - base) / CSV_MAX_PER_CLIENT);
    for (let c = 0; c < fillers; c++) {
      const ip = fresh();
      for (let i = 0; i < CSV_MAX_PER_CLIENT && csvStreamsInFlight() < CSV_MAX_CONCURRENT; i++) acquire(ip);
    }
    expect(csvStreamsInFlight()).toBe(CSV_MAX_CONCURRENT);
    const refused = acquire(fresh());
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(503);
    expect((refused as Response).headers.get("retry-after")).toBeTruthy();
    expect((refused as Response).headers.get("cache-control")).toBe("no-store");
    expect(await (refused as Response).json()).toMatchObject({ error: "server_busy" });
  });

  it("a refused export leaves nothing behind: no slot held, no CSV budget burned", () => {
    const ip = fresh();
    const now = 5_000_000;
    for (let i = 0; i < CSV_MAX_PER_CLIENT; i++) acquire(ip, now);
    const inFlight = csvStreamsInFlight();
    for (let i = 0; i < 50; i++) expect(acquire(ip, now)).toBeInstanceOf(Response); // all refused on concurrency
    expect(csvStreamsInFlight()).toBe(inFlight);
    while (held.length) held.pop()?.();
    // 50 refusals did not count as starts: the client still has (almost) its whole CSV budget.
    let started = 0;
    for (let i = 0; i < API_CSV_BUDGET.limit; i++) {
      const slot = acquireCsvSlot(from(ip), now);
      if (slot instanceof Response) break;
      slot.release();
      started += 1;
    }
    expect(started).toBe(API_CSV_BUDGET.limit - CSV_MAX_PER_CLIENT);
  });

  it("answers 429 when the client's CSV budget is spent, and frees the slot it just took", () => {
    const ip = fresh();
    const now = 6_000_000;
    for (let i = 0; i < API_CSV_BUDGET.limit; i++) (acquireCsvSlot(from(ip), now) as { release: () => void }).release();
    const before = csvStreamsInFlight();
    const refused = acquireCsvSlot(from(ip), now);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(429);
    expect(csvStreamsInFlight()).toBe(before);
  });
});

describe("clients that cannot be told apart (TRUST_PROXY unset)", () => {
  it("share one bucket whose budgets are multiplied, so the API is not taken down for everyone", () => {
    vi.stubEnv("TRUST_PROXY", "0");
    const now = 7_000_000;
    const key = (): Request => from(null);
    let allowed = 0;
    for (let i = 0; i < API_READ_BUDGET.limit * UNKNOWN_CLIENT_FACTOR + 5; i++) {
      if (guardApi(key(), "read", now) === null) allowed += 1;
    }
    expect(allowed).toBe(API_READ_BUDGET.limit * UNKNOWN_CLIENT_FACTOR);
  });

  it("only the global CSV cap applies (no per-client share of one shared key)", () => {
    vi.stubEnv("TRUST_PROXY", "0");
    const slots: Array<{ release: () => void }> = [];
    const free = CSV_MAX_CONCURRENT - csvStreamsInFlight();
    for (let i = 0; i < free; i++) {
      const slot = acquireCsvSlot(from(null), 8_000_000 + i);
      expect(slot).not.toBeInstanceOf(Response); // would be 429 after CSV_MAX_PER_CLIENT if keyed
      slots.push(slot as { release: () => void });
    }
    expect((acquireCsvSlot(from(null), 8_100_000) as Response).status).toBe(503);
    for (const s of slots) s.release();
  });

  it("logs the misconfiguration once in production", () => {
    vi.stubEnv("TRUST_PROXY", "0");
    vi.stubEnv("NODE_ENV", "production");
    const g = globalThis as unknown as { __nabdApiKeyWarned?: boolean };
    g.__nabdApiKeyWarned = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    guardApi(from(null), "read", 9_000_000);
    guardApi(from(null), "read", 9_000_001);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/TRUST_PROXY=1/);
    warn.mockRestore();
  });
});
