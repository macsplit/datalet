import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const systemChromium = "/usr/bin/chromium";

export default defineConfig({
  testDir: "./tests",
  testMatch: "offline.spec.ts",
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:41731",
    headless: true,
    launchOptions: { executablePath: existsSync(systemChromium) ? systemChromium : undefined },
  },
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 41731 --strictPort",
    url: "http://127.0.0.1:41731",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
