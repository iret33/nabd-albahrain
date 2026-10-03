import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Integration tests (tests/integration) need a migrated Postgres at
    // DATABASE_URL and are opt-in via RUN_INTEGRATION=1.
    testTimeout: 30_000,
    coverage: { provider: "v8", include: ["src/lib/**"] },
  },
});
