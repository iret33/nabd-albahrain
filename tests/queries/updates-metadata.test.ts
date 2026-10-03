import { beforeEach, describe, expect, it, vi } from "vitest";

// The page imports the data layer (Prisma); only the count is needed to test the metadata.
const count = vi.fn<(sinceDays: number | null) => Promise<number>>();
vi.mock("@/lib/queries", () => ({
  THEME_PAGE_SIZE: 30,
  countRecentlyUpdated: (sinceDays: number | null) => count(sinceDays),
  getPortalStats: vi.fn(),
  getRecentlyUpdated: vi.fn(),
}));

const { generateMetadata } = await import("@/app/updates/page");

const meta = (query: Record<string, string>) => generateMetadata({ searchParams: Promise.resolve(query) });
const canonical = (m: Awaited<ReturnType<typeof meta>>) => (m.alternates as { canonical: string }).canonical;
const robots = (m: Awaited<ReturnType<typeof meta>>) => m.robots as { index?: boolean } | undefined;

beforeEach(() => {
  count.mockReset();
  count.mockResolvedValue(65); // 65 datasets at 30 per page = 3 pages
});

describe("/updates metadata clamps ?page= like /categories and /publishers (R2-13, R5-13)", () => {
  it("an out-of-range page canonicalizes to the real last page and titles itself as such (it said 10000)", async () => {
    for (const page of ["99999", "10000", "999", "4"]) {
      const m = await meta({ page });
      expect(canonical(m), `page=${page}`).toBe("/updates?page=3");
      expect(m.title).toBe("آخر التحديثات — صفحة 3");
      expect(robots(m)).toBeUndefined(); // the last page is a real, indexable page
    }
  });

  it("in-range pages and page 1 are unchanged", async () => {
    expect(canonical(await meta({ page: "2" }))).toBe("/updates?page=2");
    expect(canonical(await meta({ page: "3" }))).toBe("/updates?page=3");
    expect(canonical(await meta({}))).toBe("/updates");
    expect(canonical(await meta({ page: "1" }))).toBe("/updates");
    expect((await meta({})).title).toBe("آخر التحديثات");
  });

  it("garbage pages fall back to page 1", async () => {
    for (const page of ["abc", "-3", "1e21", "0", "100000"]) expect(canonical(await meta({ page })), page).toBe("/updates");
  });

  it("an empty catalog has exactly one page", async () => {
    count.mockResolvedValue(0);
    expect(canonical(await meta({ page: "7" }))).toBe("/updates");
  });

  it("exactly full pages: 60 datasets are two pages, not three", async () => {
    count.mockResolvedValue(60);
    expect(canonical(await meta({ page: "99" }))).toBe("/updates?page=2");
  });

  it("a windowed view is noindex with the plain canonical and does not even count", async () => {
    const m = await meta({ days: "7", page: "99999" });
    expect(canonical(m)).toBe("/updates");
    expect(robots(m)).toEqual({ index: false, follow: true });
    expect(count).not.toHaveBeenCalled();
  });

  it("page 1 needs no count either", async () => {
    await meta({});
    expect(count).not.toHaveBeenCalled();
  });

  it("counts the all-time window (null), the same one the listing shows", async () => {
    await meta({ page: "5" });
    expect(count).toHaveBeenCalledWith(null);
  });

  it("a database failure degrades to the plain canonical instead of failing the page's metadata", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    count.mockRejectedValue(new Error("db down"));
    const m = await meta({ page: "5" });
    expect(canonical(m)).toBe("/updates");
    expect(m.title).toBe("آخر التحديثات");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
