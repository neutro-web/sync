import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    include: ["test/browser/**/*.test.ts"],
    benchmark: {
      include: ["bench/persistence.bench.ts", "bench/transport.bench.ts"],
    },
    browser: {
      enabled: true,
      provider: playwright({
        launchOptions: {
          headless: true,
        },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
