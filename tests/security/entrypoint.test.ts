import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { weakSecretReason } from "@/lib/env";

/**
 * Runs the REAL docker/entrypoint.sh under `sh` (dash here, busybox ash in the
 * image — the script sticks to POSIX) with `node` and `prisma` replaced by
 * stubs that just print what they were asked to do. Proves: the secret checks
 * run before migration, the mode dispatch (server / sync / passthrough) works,
 * and the sh checks agree with `weakSecretReason` from src/lib/env.ts.
 */

const ENTRYPOINT = path.resolve(__dirname, "../../docker/entrypoint.sh");
const GOOD_ADMIN = "9f2c1ab07d3e4568b1c0a7e2d4f65b83a1c9e07d2b4f6a8c0e1d3b5a7c9e2f40";
const GOOD_SYNC = "0be7a4d1c6f28359e0b4a7d2c1f68e35b9a0d4c7e2f1a6b8d3c5e9f07a2b4c61";

let work: string;
let stubBin: string;

// The container is Linux/busybox; the script is POSIX sh and needs coreutils (fold/sort/wc/tr).
const SKIP = process.platform === "win32";

beforeAll(() => {
  if (SKIP) return;
  work = mkdtempSync(path.join(tmpdir(), "nabd-entrypoint-"));
  stubBin = path.join(work, "stub-bin");
  mkdirSync(stubBin);
  mkdirSync(path.join(work, "node_modules/.bin"), { recursive: true });
  const stub = (file: string, body: string) => {
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub(path.join(work, "node_modules/.bin/prisma"), 'echo "PRISMA $*"');
  stub(path.join(stubBin, "node"), 'echo "NODE $*"');
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string>) {
  const r = spawnSync("sh", [ENTRYPOINT, ...args], {
    cwd: work,
    env: { PATH: `${stubBin}:/usr/bin:/bin`, NODE_ENV: "production", ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const validEnv = { ADMIN_TOKEN: GOOD_ADMIN, SYNC_TOKEN: GOOD_SYNC, DATABASE_URL: "postgresql://u:p@db:5432/nabd" };

describe.skipIf(SKIP)("entrypoint.sh: modes", () => {
  it("migrates then starts the server with no arguments", () => {
    const r = run([], validEnv);
    expect(r.code).toBe(0);
    expect(r.out.indexOf("PRISMA migrate deploy")).toBeGreaterThanOrEqual(0);
    expect(r.out.indexOf("PRISMA migrate deploy")).toBeLessThan(r.out.indexOf("NODE server.js"));
  });

  it("`sync -- <flags>` migrates then execs the bundled CLI with just the flags", () => {
    const r = run(["sync", "--", "--dataset", "seaports", "--force"], validEnv);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PRISMA migrate deploy");
    expect(r.out).toContain("NODE dist/sync-cli.cjs --dataset seaports --force");
    expect(r.out).not.toContain("server.js");
  });

  it("`sync` without `--` and without flags works too", () => {
    expect(run(["sync"], validEnv).out).toMatch(/NODE dist\/sync-cli\.cjs\s*$/m);
    expect(run(["sync", "--recompute"], validEnv).out).toContain("NODE dist/sync-cli.cjs --recompute");
  });

  it("any other command is exec'd as-is, with no secret check and no migration", () => {
    const r = run(["node", "-v"], { NODE_ENV: "production" /* no secrets at all */ });
    expect(r.code).toBe(0);
    expect(r.out).toContain("NODE -v");
    expect(r.out).not.toContain("PRISMA");
  });

  it("enforces secrets only when NODE_ENV=production (mirrors env.ts)", () => {
    const r = run([], { NODE_ENV: "development", ADMIN_TOKEN: "dev", SYNC_TOKEN: "dev" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("NODE server.js");
  });
});

describe.skipIf(SKIP)("entrypoint.sh: fails closed before migrating", () => {
  const refused = (env: Record<string, string>, args: string[] = []) => {
    const r = run(args, env);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("PRISMA");
    expect(r.out).not.toContain("NODE");
    return r.err;
  };

  it("missing / placeholder / short / identical secrets and missing DATABASE_URL", () => {
    expect(refused({ ...validEnv, ADMIN_TOKEN: "" })).toContain("ADMIN_TOKEN is not set");
    expect(refused({ ...validEnv, SYNC_TOKEN: "change-me-long-random-change-me-long-random" })).toContain("SYNC_TOKEN looks like a placeholder");
    expect(refused({ ...validEnv, ADMIN_TOKEN: "short" })).toContain("ADMIN_TOKEN is shorter than 32");
    expect(refused({ ...validEnv, SYNC_TOKEN: GOOD_ADMIN })).toContain("must be different");
    expect(refused({ ADMIN_TOKEN: GOOD_ADMIN, SYNC_TOKEN: GOOD_SYNC })).toContain("DATABASE_URL is not set");
  });

  it("also guards the sync mode, and never prints a secret value", () => {
    const err = refused({ ...validEnv, ADMIN_TOKEN: "hunter2hunter2hunter2hunter2hunter2hunter2" }, ["sync", "--", "--force"]);
    expect(err).not.toContain("hunter2");
  });
});

describe.skipIf(SKIP)("entrypoint.sh agrees with src/lib/env.ts weakSecretReason", () => {
  const values: Array<string | undefined> = [
    "5c8e1f03a7b94d26e0c3f81a9b7d5e42c6a0f3b8d1e47a95c2b60f8e3d1a7c94", // valid, and different from validEnv's tokens
    "Zk3-pQ9_vLm2XrT8uYw5NbC7HdJ4sFgA1eO6iKaV",
    undefined,
    "",
    "abc123",
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d", // 31 chars
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", // exactly 32 chars, fine
    "change-me-long-random-change-me-long-random",
    "ChangeMe0123456789abcdef0123456789abcdef",
    "CHANGE_ME_0123456789abcdef0123456789abcdef",
    "dev-admin-token-0123456789abcdef0123456789abcdef",
    "Dev_admin_token_0123456789abcdef0123456789abcdef",
    "test-token-0123456789abcdef0123456789abcdef",
    "your-token-0123456789abcdef0123456789abcdef!",
    "example0123456789abcdef0123456789abcdef0123",
    "xx-my-super-password-xx-0123456789abcdef0123",
    "0123456789abcdef-PlaceHolder-0123456789abcdef",
    "a".repeat(64),
    "ab".repeat(32),
    "abcdefg".repeat(10), // 7 distinct chars
    "abcdefgh".repeat(8), // 8 distinct chars: allowed
  ];

  it.each(values.map((v) => [JSON.stringify(v), v] as const))("%s", (_label, value) => {
    const expectOk = weakSecretReason(value) === null;
    for (const which of ["ADMIN_TOKEN", "SYNC_TOKEN"] as const) {
      const env: Record<string, string> = { ...validEnv };
      if (value === undefined) delete env[which];
      else env[which] = value;
      const r = run([], env);
      expect(r.code === 0, `${which}=${JSON.stringify(value)} -> exit ${r.code}: ${r.err.trim()}`).toBe(expectOk);
    }
  });
});
