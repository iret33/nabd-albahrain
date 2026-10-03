import { describe, expect, it } from "vitest";
import { BusyError, createSlotLimiter, resolveHeavyQueryLimit } from "@/lib/slot-limiter";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSlotLimiter", () => {
  it("runs up to max at once and refuses the rest immediately", async () => {
    const limiter = createSlotLimiter(2);
    const a = deferred();
    const b = deferred();
    const first = limiter.run(() => a.promise);
    const second = limiter.run(() => b.promise);
    expect(limiter.inFlight).toBe(2);

    let ran = false;
    await expect(
      limiter.run(async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(BusyError);
    expect(ran).toBe(false);

    a.resolve();
    await first;
    expect(limiter.inFlight).toBe(1);
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");

    b.resolve();
    await second;
    expect(limiter.inFlight).toBe(0);
  });

  it("frees the slot when the work throws", async () => {
    const limiter = createSlotLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(limiter.inFlight).toBe(0);
    await expect(limiter.run(async () => 1)).resolves.toBe(1);
  });

  it("passes results through", async () => {
    const limiter = createSlotLimiter(3);
    expect(await Promise.all([1, 2, 3].map((n) => limiter.run(async () => n * 2)))).toEqual([2, 4, 6]);
  });
});

describe("tryAcquire (slots that outlive the call)", () => {
  it("hands out up to max slots and refuses the next without running anything", () => {
    const limiter = createSlotLimiter(2);
    const a = limiter.tryAcquire();
    const b = limiter.tryAcquire();
    expect(a).toBeTypeOf("function");
    expect(b).toBeTypeOf("function");
    expect(limiter.inFlight).toBe(2);
    expect(limiter.tryAcquire()).toBeNull();
    expect(limiter.refusal()).toBe("global");
    a?.();
    expect(limiter.inFlight).toBe(1);
    expect(limiter.refusal()).toBeNull();
    expect(limiter.tryAcquire()).toBeTypeOf("function");
  });

  it("release frees the slot exactly once, however often it is called", () => {
    const limiter = createSlotLimiter(2);
    const release = limiter.tryAcquire() as () => void;
    const other = limiter.tryAcquire() as () => void;
    release();
    release();
    release();
    // A double release must not free the OTHER holder's slot as well.
    expect(limiter.inFlight).toBe(1);
    other();
    expect(limiter.inFlight).toBe(0);
  });

  it("run() with a promise frees its slot when the promise settles, not before", async () => {
    const limiter = createSlotLimiter(1);
    const gate = deferred();
    const running = limiter.run(() => gate.promise);
    expect(limiter.tryAcquire()).toBeNull();
    gate.resolve();
    await running;
    expect(limiter.tryAcquire()).toBeTypeOf("function");
  });
});

describe("per-key share", () => {
  it("lets one key hold at most perKey slots and leaves the rest to others", () => {
    const limiter = createSlotLimiter(4, { perKey: 2 });
    expect(limiter.tryAcquire("a")).toBeTypeOf("function");
    expect(limiter.tryAcquire("a")).toBeTypeOf("function");
    expect(limiter.tryAcquire("a")).toBeNull();
    expect(limiter.refusal("a")).toBe("client");
    // Another client still gets in, and the global cap still applies to everyone.
    expect(limiter.tryAcquire("b")).toBeTypeOf("function");
    expect(limiter.tryAcquire("c")).toBeTypeOf("function");
    expect(limiter.refusal("d")).toBe("global");
    expect(limiter.tryAcquire("d")).toBeNull();
  });

  it("gives a key its share back on release", () => {
    const limiter = createSlotLimiter(3, { perKey: 1 });
    const release = limiter.tryAcquire("a") as () => void;
    expect(limiter.tryAcquire("a")).toBeNull();
    release();
    expect(limiter.tryAcquire("a")).toBeTypeOf("function");
  });

  it("run() carries the scope on BusyError so callers can tell 'you' from 'everyone'", async () => {
    const limiter = createSlotLimiter(2, { perKey: 1 });
    const gate = deferred();
    const first = limiter.run(() => gate.promise, "a");
    await expect(limiter.run(async () => 1, "a")).rejects.toMatchObject({ name: "BusyError", scope: "client" });
    const second = limiter.run(() => gate.promise, "b");
    await expect(limiter.run(async () => 1, "c")).rejects.toMatchObject({ name: "BusyError", scope: "global" });
    gate.resolve();
    await Promise.all([first, second]);
    expect(limiter.inFlight).toBe(0);
  });

  it("keys are optional: unkeyed callers are only subject to the global cap", () => {
    const limiter = createSlotLimiter(3, { perKey: 1 });
    expect(limiter.tryAcquire()).toBeTypeOf("function");
    expect(limiter.tryAcquire()).toBeTypeOf("function");
    expect(limiter.tryAcquire()).toBeTypeOf("function");
    expect(limiter.tryAcquire()).toBeNull();
  });
});

describe("resolveHeavyQueryLimit", () => {
  const url = (query = "") => `postgresql://u:p@db:5432/nabd${query}`;

  it("defaults to 4", () => {
    expect(resolveHeavyQueryLimit(undefined, url())).toBe(4);
    expect(resolveHeavyQueryLimit("", undefined)).toBe(4);
  });

  it("takes an explicit 1..16 from the environment", () => {
    expect(resolveHeavyQueryLimit("2", url())).toBe(2);
    expect(resolveHeavyQueryLimit(" 16 ", url())).toBe(16);
  });

  it("ignores nonsense and reports it", () => {
    const seen: string[] = [];
    for (const bad of ["0", "17", "-1", "2.5", "abc", "1e1"]) {
      expect(resolveHeavyQueryLimit(bad, url(), (m) => seen.push(m))).toBe(4);
    }
    expect(seen).toHaveLength(6);
  });

  it("keeps two pooled connections free when the pool is pinned in DATABASE_URL", () => {
    expect(resolveHeavyQueryLimit(undefined, url("?connection_limit=10"))).toBe(4);
    expect(resolveHeavyQueryLimit(undefined, url("?connection_limit=5"))).toBe(3);
    expect(resolveHeavyQueryLimit(undefined, url("?schema=public&connection_limit=3"))).toBe(1);
    expect(resolveHeavyQueryLimit(undefined, url("?connection_limit=1"))).toBe(1); // never below one
  });
});
