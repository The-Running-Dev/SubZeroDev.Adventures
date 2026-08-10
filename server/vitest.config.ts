import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The integration suites (api.test.ts, principal.test.ts, badges.test.ts) all point
    // at the one Postgres DATABASE_URL and each truncates the same shared tables in its
    // own beforeEach. Running test files in parallel worker threads -- Vitest's default --
    // lets one file's truncate race another file's insert into the same tables, which
    // surfaces as a spurious foreign-key violation rather than an assertion failure.
    // Sequential files keep each suite's beforeEach/afterEach honest; this project is
    // small enough that the wall-clock cost is negligible.
    fileParallelism: false,
  },
});
