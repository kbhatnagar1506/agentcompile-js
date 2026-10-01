import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: { lines: 90, branches: 80, functions: 90, statements: 90 },
    },
  },
});
