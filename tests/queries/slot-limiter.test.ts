import { describe, expect, it } from "vitest";
import { BusyError, createSlotLimiter } from "@/lib/slot-limiter";

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
