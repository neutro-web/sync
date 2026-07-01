import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/browser/**"],
    benchmark: {
      include: ["bench/websocket.bench.ts"],
    },
  },
});
