import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
    // Parallel workers intermittently segfault on this Windows host; the threads pool also crashed
    // after long integration suites (0xC0000005). One forked child is the stable configuration.
    // Vitest 4 moved pool options to the top level.
    pool: "forks",
    singleFork: true,
    // Behavior-parity fixtures are plain JSON/TS snapshots; no timers needed.
    testTimeout: 10_000,
  },
});
