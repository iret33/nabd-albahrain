import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  // tsconfig says `jsx: preserve` (Next compiles the JSX itself); tests that
  // render a component to a string need esbuild to compile it.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Integration tests (tests/integration) need a migrated Postgres at
    // DATABASE_URL and are opt-in via RUN_INTEGRATION=1.
    testTimeout: 30_000,
    // Integration test files share one Postgres database (they truncate and
    // re-seed it), so they must not run in parallel with each other.
    fileParallelism: process.env.RUN_INTEGRATION !== "1",
    // No `coverage` block: its provider (@vitest/coverage-v8) is not a
    // dependency, so `vitest --coverage` could only fail. Add both together
    // (with a `test:coverage` script) if coverage is ever wanted.
  },
});
