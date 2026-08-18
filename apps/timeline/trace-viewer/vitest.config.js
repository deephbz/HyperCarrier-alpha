import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["trace-viewer/src/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
  },
});
