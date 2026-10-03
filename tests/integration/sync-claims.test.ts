import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimCatalogCooldown,
  claimDatasetCooldown,
  peekCatalogCooldown,
  peekDatasetCooldown,
  type CooldownClaim,
} from "@/lib/sync/public-refresh";
import { RUN_INTEGRATION, databaseName, setupHarness, type Harness } from "./helpers";

/** The anchor as text straight from the database (no JS Date round trip). */
const TS = 'YYYY-MM-DD"T"HH24:MI:SS.US';

describe.skipIf(!RUN_INTEGRATION)("public refresh cooldown claims (integration)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await setupHarness();
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h.reset();
    await h.seed();
  });

  const datasetAnchor = async (id: string) => {
    const rows = await h.prisma.$queryRawUnsafe<Array<{ a: string | null }>>(
      `SELECT to_char("refreshRequestedAt", '${TS}') AS a FROM "Dataset" WHERE "id" = $1`,
      id,
    );
    return rows[0]?.a ?? null;
  };
  const catalogAnchor = async () => {
    const rows = await h.prisma.$queryRawUnsafe<Array<{ a: string | null }>>(
      `SELECT to_char("lastPublicRefreshAt", '${TS}') AS a FROM "SyncState" WHERE "id" = 1`,
    );
    return rows[0]?.a ?? null;
  };
  const claimed = (c: CooldownClaim) => {
    if (!c.claimed) throw new Error("expected a claim");
    return c;
  };

  it("exactly one of many simultaneous claims wins, dataset and catalog alike (row lock, no read-then-write window)", async () => {
    const dataset = await Promise.all(Array.from({ length: 30 }, () => claimDatasetCooldown("seaports", 600)));
    expect(dataset.filter((c) => c.claimed)).toHaveLength(1);
    const lost = dataset.find((c) => !c.claimed);
    expect(lost && !lost.claimed && lost.retryAfterSeconds).toBeGreaterThan(590);

    const catalog = await Promise.all(Array.from({ length: 30 }, () => claimCatalogCooldown(120)));
    expect(catalog.filter((c) => c.claimed)).toHaveLength(1);
  });

  it("release() gives the claim back: the anchor returns to NULL and the next press can claim", async () => {
    const first = claimed(await claimDatasetCooldown("seaports", 600));
    expect(await datasetAnchor("seaports")).not.toBeNull();
    expect((await claimDatasetCooldown("seaports", 600)).claimed).toBe(false);
    await first.release();
    expect(await datasetAnchor("seaports")).toBeNull();
    expect((await claimDatasetCooldown("seaports", 600)).claimed).toBe(true);

    const cat = claimed(await claimCatalogCooldown(120));
    expect(await catalogAnchor()).not.toBeNull();
    await cat.release();
    expect(await catalogAnchor()).toBeNull();
    expect((await claimCatalogCooldown(120)).claimed).toBe(true);
  });

  it("release() restores a NON-NULL previous anchor exactly", async () => {
    await h.prisma.$executeRawUnsafe(
      `UPDATE "Dataset" SET "refreshRequestedAt" = timezone('utc', now()) - interval '20 minutes' WHERE "id" = 'seaports'`,
    );
    await h.prisma.$executeRawUnsafe(
      `UPDATE "SyncState" SET "lastPublicRefreshAt" = timezone('utc', now()) - interval '10 minutes' WHERE "id" = 1`,
    );
    const before = { dataset: await datasetAnchor("seaports"), catalog: await catalogAnchor() };
    const d = claimed(await claimDatasetCooldown("seaports", 600));
    const c = claimed(await claimCatalogCooldown(120));
    expect(await datasetAnchor("seaports")).not.toBe(before.dataset);
    await d.release();
    await c.release();
    expect(await datasetAnchor("seaports")).toBe(before.dataset);
    expect(await catalogAnchor()).toBe(before.catalog);
  });

  it("release() is a compare-and-set: it never wipes a LATER legitimate claim", async () => {
    // cooldown 0 lets a second press claim straight after the first
    const a = claimed(await claimDatasetCooldown("seaports", 0));
    const anchorA = await datasetAnchor("seaports");
    const b = claimed(await claimDatasetCooldown("seaports", 0));
    const anchorB = await datasetAnchor("seaports");
    expect(anchorB).not.toBe(anchorA);
    await a.release(); // stale: the anchor now holds B's claim, so this must do nothing
    expect(await datasetAnchor("seaports")).toBe(anchorB);
    await b.release(); // B's own release restores what B found: A's anchor
    expect(await datasetAnchor("seaports")).toBe(anchorA);
  });

  it("peek reports a running cooldown without claiming or changing anything", async () => {
    expect(await peekDatasetCooldown("seaports", 600)).toEqual({ active: false });
    expect(await peekCatalogCooldown(120)).toEqual({ active: false });
    await claimDatasetCooldown("seaports", 600);
    await claimCatalogCooldown(120);
    const dataset = await peekDatasetCooldown("seaports", 600);
    expect(dataset.active && dataset.retryAfterSeconds).toBeGreaterThan(590);
    const catalog = await peekCatalogCooldown(120);
    expect(catalog.active && catalog.retryAfterSeconds).toBeGreaterThan(110);
    const anchor = await datasetAnchor("seaports");
    await peekDatasetCooldown("seaports", 600);
    expect(await datasetAnchor("seaports")).toBe(anchor);

    // an elapsed cooldown and an unknown dataset both read as "not running"
    await h.prisma.$executeRawUnsafe(
      `UPDATE "Dataset" SET "refreshRequestedAt" = timezone('utc', now()) - interval '11 minutes' WHERE "id" = 'seaports'`,
    );
    expect(await peekDatasetCooldown("seaports", 600)).toEqual({ active: false });
    expect(await peekDatasetCooldown("no-such-dataset", 600)).toEqual({ active: false });
  });

  it("an unknown dataset cannot be claimed; a missing SyncState row is created by the catalog claim", async () => {
    const unknown = await claimDatasetCooldown("no-such-dataset", 600);
    expect(unknown.claimed).toBe(false);
    await h.prisma.$executeRawUnsafe('DELETE FROM "SyncState"');
    expect((await claimCatalogCooldown(120)).claimed).toBe(true);
    expect(await catalogAnchor()).not.toBeNull();
  });

  describe("database time zone independence", () => {
    it("claim, peek and release behave the same when the database runs in a non-UTC zone", async () => {
      const db = databaseName();
      await h.prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" SET timezone TO 'Asia/Bahrain'`);
      await h.prisma.$disconnect(); // new sessions pick up the new default
      try {
        const [{ tz }] = await h.prisma.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`;
        expect(tz).toBe("Asia/Bahrain");

        const first = claimed(await claimDatasetCooldown("seaports", 600));
        const second = await claimDatasetCooldown("seaports", 600);
        expect(second.claimed).toBe(false);
        expect(!second.claimed && second.retryAfterSeconds).toBeGreaterThan(590);
        expect(!second.claimed && second.retryAfterSeconds).toBeLessThanOrEqual(600);
        expect((await peekDatasetCooldown("seaports", 600)).active).toBe(true);
        await first.release();
        expect(await datasetAnchor("seaports")).toBeNull();
        expect((await peekDatasetCooldown("seaports", 600)).active).toBe(false);

        const cat = claimed(await claimCatalogCooldown(120));
        await cat.release();
        expect(await catalogAnchor()).toBeNull();
      } finally {
        await h.prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" RESET timezone`);
        await h.prisma.$disconnect();
      }
    });
  });
});
