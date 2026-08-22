import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const systemChromium = "/usr/bin/chromium";

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["offline.spec.ts", "screenshots.spec.ts", "fuzz.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:41730",
    headless: true,
    launchOptions: { executablePath: existsSync(systemChromium) ? systemChromium : undefined },
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 41730 --strictPort",
    url: "http://127.0.0.1:41730",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
