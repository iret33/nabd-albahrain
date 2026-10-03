import { describe, expect, it } from "vitest";
import { describeScope, describeTrigger, lastRunAlert, resolveSyncRunStatus } from "@/lib/admin/sync-status";

const row = (over: Partial<Parameters<typeof resolveSyncRunStatus>[0]> = {}) => ({
  status: "success",
  finishedAt: new Date(),
  processed: 10,
  succeeded: 10,
  failed: 0,
  ...over,
});
const latestIdle = { isLatest: true, lockRunning: false };

describe("resolveSyncRunStatus", () => {
  it("passes every finalized status through untouched", () => {
    for (const status of ["success", "partial", "failed", "aborted"] as const) {
      expect(resolveSyncRunStatus(row({ status }), latestIdle)).toBe(status);
    }
  });

  it("keeps a genuinely running latest row running while the lock is held", () => {
    const live = row({ status: "running", finishedAt: null, processed: 3 });
    expect(resolveSyncRunStatus(live, { isLatest: true, lockRunning: true })).toBe("running");
  });

  it("calls a running row aborted when nothing holds the lock or it is not the newest", () => {
    const stuck = row({ status: "running", finishedAt: null });
    expect(resolveSyncRunStatus(stuck, { isLatest: true, lockRunning: false })).toBe("aborted");
    expect(resolveSyncRunStatus(stuck, { isLatest: false, lockRunning: true })).toBe("aborted");
  });

  it("classifies finished rows still marked running (legacy engine) from their counters", () => {
    expect(resolveSyncRunStatus(row({ status: "running" }), latestIdle)).toBe("success");
    expect(resolveSyncRunStatus(row({ status: "running", failed: 2, succeeded: 8 }), latestIdle)).toBe("partial");
    expect(resolveSyncRunStatus(row({ status: "running", failed: 10, succeeded: 0 }), latestIdle)).toBe("failed");
    // ...even when a newer run holds the lock
    expect(resolveSyncRunStatus(row({ status: "running" }), { isLatest: false, lockRunning: true })).toBe("success");
  });

  it("returns null for a status it does not know", () => {
    expect(resolveSyncRunStatus(row({ status: "weird" }), latestIdle)).toBeNull();
  });
});

describe("lastRunAlert", () => {
  it("alerts on failed (red) and aborted (amber) only", () => {
    expect(lastRunAlert("failed")).toBe("failed");
    expect(lastRunAlert("aborted")).toBe("aborted");
    for (const s of ["running", "success", "partial", null] as const) expect(lastRunAlert(s)).toBeNull();
  });
});

describe("labels", () => {
  it("describes known triggers/scopes and falls back to the raw value", () => {
    expect(describeTrigger("cli")).toBe("سطر الأوامر");
    expect(describeTrigger("somethingnew")).toBe("somethingnew");
    expect(describeScope(null)).toBeNull();
    expect(describeScope("all")).toBe("كل المجموعات");
    expect(describeScope("recompute")).toBe("إعادة حساب المخططات");
    expect(describeScope("dataset:seaports")).toBe("مجموعة: seaports");
    expect(describeScope("odd")).toBe("odd");
  });
});
