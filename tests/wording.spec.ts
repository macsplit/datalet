import { expect, test } from "@playwright/test";

/**
 * "Graph" means a chart to most people and a network to the rest, so it is
 * jargon whichever way it is read. The word for this concept in the interface
 * is "datalet". This walks the pages a user actually sees and fails if it
 * reappears, because it is the kind of term that creeps back one string at a
 * time.
 */
const PAGES = ["/", "/settings", "/settings/theme", "/settings/schemas", "/settings/tabs"];

test("no page says \"graph\" to the user", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "wording", private_store_id: "test-private-store",
    }));
  });

  const offenders: string[] = [];
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForTimeout(300);
    // innerText, not the HTML: class names and data attributes are not read by
    // anyone, and the test would be unmaintainable if they counted.
    const text = await page.locator("body").innerText();
    for (const line of text.split("\n")) {
      if (/\bgraphs?\b/i.test(line)) offenders.push(`${path}: ${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});
