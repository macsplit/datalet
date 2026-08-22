import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const systemChromium = "/usr/bin/chromium";

/**
 * The fuzzer runs on demand, not with `pnpm test`: it is random by design, so
 * a failure is a lead to investigate rather than a regression to block a
 * merge on. Reproduce any failure with the seed it prints.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: "fuzz.spec.ts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:41733",
    headless: true,
    launchOptions: { executablePath: existsSync(systemChromium) ? systemChromium : undefined },
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 41733 --strictPort",
    url: "http://127.0.0.1:41733",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
