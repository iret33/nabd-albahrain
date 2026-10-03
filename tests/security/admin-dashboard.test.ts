import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminStats, AdminSyncLogRow } from "@/lib/admin/queries";
import { isQuietPublicPress } from "@/lib/admin/sync-status";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, replace() {} }) }));

import { AdminDashboard } from "@/components/admin/admin-dashboard";

/**
 * Server-renders the dashboard (no browser) to pin the run-history behaviour of
 * r1-13: the "show all runs" toggle, the hidden-presses note, quiet rows being
 * marked when shown, and "is this row the live run" following the true newest
 * real run rather than the first row of a filtered list.
 */

let id = 0;
function log(over: Partial<AdminSyncLogRow> = {}): AdminSyncLogRow {
  id += 1;
  return {
    id,
    trigger: "auto",
    startedAt: new Date(Date.UTC(2026, 9, 3, 12, 0, 0) - id * 60_000),
    finishedAt: new Date(Date.UTC(2026, 9, 3, 12, 0, 5) - id * 60_000),
    processed: 3,
    succeeded: 3,
    failed: 0,
    status: "success",
    error: null,
    total: 3,
    skipped: 0,
    updated: 0,
    scope: "all",
    ...over,
  };
}

function render(props: { logs: AdminSyncLogRow[]; lastSync?: AdminSyncLogRow | null; showAllRuns?: boolean; quietPublicPresses?: number; lockRunning?: boolean }) {
  const stats: AdminStats = {
    total: 10,
    ok: 10,
    partial: 0,
    error: 0,
    pending: 0,
    removed: 0,
    lastSync: props.lastSync === undefined ? (props.logs[0] ?? null) : props.lastSync,
  };
  return renderToStaticMarkup(
    createElement(AdminDashboard, {
      stats,
      freshness: { lastCatalogCheckAt: null, lastSuccessAt: null, lastDataChangeAt: null },
      failures: [],
      logs: props.logs,
      showAllRuns: props.showAllRuns ?? false,
      quietPublicPresses: props.quietPublicPresses ?? 0,
      datasets: [],
      initialLock: { running: props.lockRunning ?? false, since: null, heartbeatAt: null, stale: false },
    }),
  );
}

describe("isQuietPublicPress", () => {
  const quiet = { trigger: "public", status: "success", failed: 0, updated: 0 };
  it("is true only for a clean public press that changed nothing", () => {
    expect(isQuietPublicPress(quiet)).toBe(true);
    expect(isQuietPublicPress({ ...quiet, trigger: "auto" })).toBe(false);
    expect(isQuietPublicPress({ ...quiet, trigger: "api" })).toBe(false);
    for (const status of ["partial", "failed", "aborted", "running", "weird"]) {
      expect(isQuietPublicPress({ ...quiet, status }), status).toBe(false);
    }
    expect(isQuietPublicPress({ ...quiet, failed: 1 })).toBe(false);
    expect(isQuietPublicPress({ ...quiet, updated: 1 })).toBe(false);
  });
});

describe("admin run history toggle", () => {
  it("shows nothing extra when there are no quiet presses and the filter is on", () => {
    const html = render({ logs: [log()], quietPublicPresses: 0 });
    expect(html).not.toContain('data-testid="toggle-all-runs"');
    expect(html).not.toContain('data-testid="hidden-runs-note"');
  });

  it("offers 'show all runs' and says how many presses are hidden, with Arabic count agreement", () => {
    for (const [n, phrase] of [
      [1, "ضغطة واحدة"],
      [2, "ضغطتان"],
      [5, "5 ضغطات"],
      [14, "14 ضغطةً"],
      [1200, "1,200 ضغطةً"],
    ] as const) {
      const html = render({ logs: [log()], quietPublicPresses: n });
      expect(html, String(n)).toContain('href="/admin?runs=all"');
      expect(html).toContain("عرض كل العمليات");
      expect(html).toContain(phrase);
      expect(html).toContain('data-testid="hidden-runs-note"');
    }
  });

  it("when everything is shown, offers to hide them again and marks the quiet rows", () => {
    const quiet = log({ trigger: "public" });
    const real = log({ trigger: "auto" });
    const html = render({ logs: [quiet, real], lastSync: real, showAllRuns: true, quietPublicPresses: 1 });
    expect(html).toContain('href="/admin"');
    expect(html).toContain("إخفاء ضغطات التحديث العامة بلا تغيير");
    expect(html).not.toContain('data-testid="hidden-runs-note"');
    expect(html.match(/data-quiet-press="true"/g)).toHaveLength(1);
  });

  it("keeps public failures, partials and presses that changed data unmarked", () => {
    const rows = [
      log({ trigger: "public", status: "failed", failed: 1, error: "export 500" }),
      log({ trigger: "public", status: "partial", failed: 1, updated: 1 }),
      log({ trigger: "public", updated: 2 }),
    ];
    const html = render({ logs: rows, showAllRuns: true, quietPublicPresses: 0 });
    expect(html).not.toContain("data-quiet-press");
    expect(html).toContain("export 500");
  });

  it("says so when only quiet presses exist and the filter hides them all", () => {
    const html = render({ logs: [], lastSync: null, quietPublicPresses: 3 });
    expect(html).toContain("لا توجد عمليات مزامنة أخرى بعد.");
    expect(html).toContain('href="/admin?runs=all"');
  });
});

describe("admin run history: which row is the live run", () => {
  const badgeCount = (html: string, label: string) => html.split(label).length - 1;

  it("an orphaned 'running' row older than the newest real run is shown aborted, even when it is the first row of a filtered list", () => {
    // Unfiltered newest row is a quiet press (hidden); the first listed row is the orphan, but the
    // true newest real run is `newest`, so nothing here may claim to be running.
    const orphan = log({ trigger: "auto", status: "running", finishedAt: null });
    const newest = log({ trigger: "api", status: "success" });
    const html = render({ logs: [orphan], lastSync: newest, lockRunning: true });
    expect(badgeCount(html, "قيد التنفيذ")).toBe(badgeCount(html, "مزامنة قيد التنفيذ…"));
    expect(html).toContain("أُوقفت");
  });

  it("the newest real run, if still running while the lock is held, is shown as running", () => {
    const live = log({ trigger: "public", status: "running", finishedAt: null });
    const html = render({ logs: [live, log()], lastSync: live, lockRunning: true });
    expect(html).not.toContain("أُوقفت");
    expect(html).toContain("قيد التنفيذ");
  });
});
