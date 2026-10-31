import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    // Prove HOME isolation in every worker before a test file loads (see test/home.mjs).
    setupFiles: ["./test/home.mjs"],
  },
});
