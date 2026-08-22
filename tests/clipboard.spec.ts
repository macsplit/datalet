import { expect, test, type Page } from "@playwright/test";

/**
 * The clipboard is where a silent failure costs most: the next thing anyone
 * does is paste, and a stale paste looks like a success. These cover the three
 * ways Copy misled someone rather than the happy path alone.
 */

const vault = {
  vaultId: "aaaaaaaa-0000-0000-0000-000000000000",
  vaultToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  nodeId: "na",
};
const CODE = "COPY-K3RM-9T7A-*";

/**
 * `navigator.clipboard` is a prototype accessor, so it has to be shadowed
 * rather than deleted. `undefined` is precisely what a page served over plain
 * http sees - which is every LAN address except localhost.
 */
async function seed(page: Page, options: { clipboard: "present" | "absent"; execCommand?: boolean }) {
  await page.addInitScript((input) => {
    localStorage.clear();
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "clip", private_store_id: "test-private-store",
    }));
    localStorage.setItem("meta-ui-builder:datalets", JSON.stringify({
      activeId: "a", entries: [{ id: "a", vault: input.vault }],
    }));
    if (input.clipboard === "absent") {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
    if (input.execCommand === false) {
      Object.defineProperty(document, "execCommand", { value: undefined, configurable: true });
    } else {
      // Record what the legacy path put on the clipboard; Playwright cannot
      // read the real one back without a permission grant.
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: (command: string) => {
          if (command !== "copy") return false;
          (window as unknown as Record<string, unknown>).__legacyCopied =
            String(window.getSelection() ?? "") || (document.activeElement as HTMLTextAreaElement)?.value;
          return true;
        },
      });
    }
  }, { vault, clipboard: options.clipboard, execCommand: options.execCommand });

  await page.route("**/sync/snapshot?*", (r) => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ seq: 1, records: {} }) }));
  await page.route("**/sync/stream?*", (r) => r.abort());
  await page.route("**/sync/clone-codes*", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ codes: [{ code: CODE, createdAt: 1 }] }) }));
}

test("a copy code can be copied where the async clipboard exists", async ({ page }) => {
  await seed(page, { clipboard: "present" });
  await page.goto("/settings/datalets");
  const button = page.getByRole("button", { name: `Copy the code ${CODE}` });
  await button.click();
  await expect(button).toHaveText("Copied");
});

test("a page served over plain http still copies, via the legacy path", async ({ page }) => {
  await seed(page, { clipboard: "absent" });
  await page.goto("/settings/datalets");
  const button = page.getByRole("button", { name: `Copy the code ${CODE}` });
  await button.click();
  await expect(button).toHaveText("Copied");
  expect(await page.evaluate(() => (window as unknown as Record<string, string>).__legacyCopied)).toBe(CODE);
});

test("a browser that cannot copy at all says so instead of doing nothing", async ({ page }) => {
  await seed(page, { clipboard: "absent", execCommand: false });
  await page.goto("/settings/datalets");
  await page.getByRole("button", { name: `Copy the code ${CODE}` }).click();
  // The regression this replaces: an empty catch, so the button did not
  // change, nothing was copied, and nothing was said.
  await expect(page.getByRole("alert")).toContainText("copy it by hand");
});
