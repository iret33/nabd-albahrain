import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Static guard against the one way the async auth helpers can silently turn
 * into an auth bypass: `if (!isSyncRequestAuthorized(req))` with the `await`
 * forgotten tests an always-truthy Promise, TypeScript does not complain, and
 * the route then lets everyone in. Every call of an async access-control
 * helper anywhere in src/ must therefore be awaited.
 */

const SRC = path.resolve(__dirname, "../../src");
const GUARDED = ["isSyncRequestAuthorized", "authorizeSyncRequest", "verifySession", "attemptLogin", "requireAdmin"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("async access-control helpers are always awaited", () => {
  const offenders: string[] = [];
  let callSites = 0;

  for (const file of walk(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (/^(\*|\/\/|\/\*|import\b)/.test(trimmed)) return; // comments + imports
      for (const name of GUARDED) {
        const re = new RegExp(`(^|[^\\w.])${name}\\(`, "g");
        for (const m of line.matchAll(re)) {
          const before = line.slice(0, (m.index ?? 0) + m[1].length);
          if (/\b(function|async function)\s*$/.test(before)) continue; // the definition itself
          callSites++;
          if (!/\bawait\s*\(?\s*$/.test(before)) offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${trimmed}`);
        }
      }
    });
  }

  it("finds the call sites it is meant to police", () => {
    expect(callSites).toBeGreaterThan(0);
  });

  it("has no un-awaited call", () => {
    expect(offenders).toEqual([]);
  });
});
