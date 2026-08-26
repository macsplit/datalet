import { expect, test } from "@playwright/test";

/**
 * The browser decides persistence from engagement and installed state, so a
 * real grant is not reproducible in a test run. These stub `navigator.storage`
 * to pin each outcome and check what the app tells the user about it — which
 * is the part that can be wrong.
 */
async function stubStorage(
  page: import("@playwright/test").Page,
  options: { persisted: boolean; grantOnRequest?: boolean; absent?: boolean },
) {
  await page.addInitScript((opts) => {
    if (opts.absent) {
      Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
      return;
    }
    let persisted = opts.persisted;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        persisted: async () => persisted,
        persist: async () => {
          persisted = opts.grantOnRequest === true;
          return persisted;
        },
      },
    });
  }, options);
}

test("an origin the browser already keeps is reported as safe", async ({ page }) => {
  await stubStorage(page, { persisted: true });
  await page.goto("/settings/datalets");
  await expect(page.getByText("This browser has agreed to keep your data")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask to keep data" })).toHaveCount(0);
});

test("an origin the browser may clear says so, and can ask", async ({ page }) => {
  await stubStorage(page, { persisted: false, grantOnRequest: true });
  await page.goto("/settings/datalets");
  await expect(page.getByText("This browser has not agreed to keep your data")).toBeVisible();

  await page.getByRole("button", { name: "Ask to keep data" }).click();
  await expect(page.getByText("This browser has agreed to keep your data")).toBeVisible();
});

test("a refused request is reported as refused, not as success", async ({ page }) => {
  // The failure that would matter: telling someone their data is safe when the
  // browser has just declined to keep it.
  await stubStorage(page, { persisted: false, grantOnRequest: false });
  await page.goto("/settings/datalets");
  await page.getByRole("button", { name: "Ask to keep data" }).click();

  await expect(page.getByText("just asked, and said no")).toBeVisible();
  await expect(page.getByText("This browser has agreed to keep your data")).toHaveCount(0);
});

test("a declined request reads as a real answer, not as the button doing nothing", async ({ page }) => {
  // Reported live: on mobile Chrome and Safari, which - unlike Firefox's own
  // explicit prompt - typically grant or decline this silently from
  // engagement heuristics, a decline redrew the exact same button and the
  // exact same sentence as before anyone had ever clicked it, so a real
  // refusal read as the click having done nothing at all.
  await stubStorage(page, { persisted: false, grantOnRequest: false });
  await page.goto("/settings/datalets");
  await expect(page.getByText("just asked, and said no")).toHaveCount(0);

  await page.getByRole("button", { name: "Ask to keep data" }).click();
  await expect(page.getByText("just asked, and said no")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask again" })).toBeVisible();
});

test("a browser without the API is not nagged about it", async ({ page }) => {
  // Plain-HTTP LAN origins do not expose navigator.storage. Showing a warning
  // nobody can act on would be worse than saying nothing.
  await stubStorage(page, { persisted: false, absent: true });
  await page.goto("/settings/datalets");
  await expect(page.getByText("Export or import data")).toBeVisible();
  await expect(page.getByText("agreed to keep your data")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask to keep data" })).toHaveCount(0);
});
