import { defineConfig } from "playwright/test";

export default defineConfig({
	testDir: "test/e2e",
	use: { browserName: "chromium" },
	webServer: {
		command: "pnpm exec vite test/e2e/fixtures --port 59998",
		port: 59998,
		reuseExistingServer: !process.env.CI,
	},
});
