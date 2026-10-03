import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const tsx = path.join(root, "node_modules/.bin/tsx");
const loadEnvModule = path.join(root, "src/lib/sync/load-env.ts");

function run(files: Record<string, string>, env: Record<string, string> = {}): Record<string, string | undefined> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nabd-load-env-"));
  try {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    const out = execFileSync(
      tsx,
      ["-e", `import ${JSON.stringify(loadEnvModule)}; console.log(JSON.stringify({ A: process.env.A, B: process.env.B, C: process.env.C }))`],
      { cwd: dir, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" },
    );
    return JSON.parse(out.trim().split("\n").pop() as string);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("sync CLI env loading", () => {
  it("reads .env.local and .env, with .env.local winning", () => {
    expect(run({ ".env": "A=env\nB=env\n", ".env.local": "A=local\nC=local\n" })).toEqual({ A: "local", B: "env", C: "local" });
  });
  it("never overrides a variable that is already set", () => {
    expect(run({ ".env.local": "A=local\nB=local\n" }, { A: "real" })).toEqual({ A: "real", B: "local" });
  });
  it("is fine with no env files at all", () => {
    expect(run({})).toEqual({});
  });
});
