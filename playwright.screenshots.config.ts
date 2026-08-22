import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const systemChromium = "/usr/bin/chromium";

/**
 * The documentation screenshot library. Separate from the test configs because
 * it produces artifacts rather than verdicts, and must not run in CI: a
 * screenshot that changes is news, not a failure.
 *
 * Everything that could vary between machines is pinned here - locale and
 * timezone (dates are rendered with `toLocaleDateString`), colour scheme, and
 * device scale - so that regenerating on a different machine produces the same
 * bytes and the diff stays honest.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: "screenshots.spec.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:41732",
    headless: true,
    locale: "en-GB",
    timezoneId: "UTC",
    colorScheme: "light",
    // 1x deliberately. These are read at roughly 880px on GitHub, so a 1100px
    // image is already downscaled; 2x quadrupled the bytes in the repository
    // for detail nothing renders.
    deviceScaleFactor: 1,
    launchOptions: { executablePath: existsSync(systemChromium) ? systemChromium : undefined },
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 41732 --strictPort",
    url: "http://127.0.0.1:41732",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
