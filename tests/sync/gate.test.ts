import { describe, expect, it } from "vitest";
import { createGate } from "@/lib/sync/utils";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createGate", () => {
  it("never lets more than `limit` operations run at once, and runs everything", async () => {
    const gate = createGate(2);
    let active = 0;
    let max = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        gate.run(async () => {
          active++;
          max = Math.max(max, active);
          await sleep(5);
          active--;
          done.push(i);
        }),
      ),
    );
    expect(max).toBe(2);
    expect(done.sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("serves waiters first-in first-out", async () => {
    const gate = createGate(1);
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3].map((i) => gate.run(async () => { await sleep(2); order.push(i); })));
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("releases the slot when the operation throws", async () => {
    const gate = createGate(1);
    await expect(gate.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(gate.run(async () => "next")).resolves.toBe("next");
  });

  it("drops a wait that is aborted (the operation never starts) and does not leak the slot", async () => {
    const gate = createGate(1);
    let release!: () => void;
    const first = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));

    const controller = new AbortController();
    let started = false;
    const waiting = gate.run(async () => { started = true; }, controller.signal);
    const abortReason = new Error("stopped");
    controller.abort(abortReason);
    await expect(waiting).rejects.toBe(abortReason);

    let thirdRan = false;
    const third = gate.run(async () => { thirdRan = true; });
    release();
    await first;
    await third;
    expect(started).toBe(false);
    expect(thirdRan).toBe(true);
  });

  it("rejects at once with an already-aborted signal, without taking a slot", async () => {
    const gate = createGate(1);
    const controller = new AbortController();
    controller.abort(new Error("already"));
    await expect(gate.run(async () => "x", controller.signal)).rejects.toThrow("already");
    await expect(gate.run(async () => "y")).resolves.toBe("y");
  });

  it("clamps nonsense limits to 1", async () => {
    for (const limit of [0, -3, Number.NaN]) {
      const gate = createGate(limit);
      let active = 0;
      let max = 0;
      await Promise.all(Array.from({ length: 4 }, () => gate.run(async () => { active++; max = Math.max(max, active); await sleep(1); active--; })));
      expect(max).toBe(1);
    }
  });
});
