import { expect, test } from "@playwright/test";

test("About is quietly reachable from Settings and explains storage", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("link", { name: "About Datalet, privacy, and browser storage" }).click();

  await expect(page).toHaveURL(/\/settings\/about$/);
  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "source code repository" })).toHaveAttribute(
    "href",
    "https://github.com/macsplit/datalet",
  );
  await expect(page.getByRole("heading", { name: "No cookies" })).toBeVisible();
  await expect(page.getByText("not end-to-end encrypted", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage datalets" })).toHaveAttribute(
    "href",
    "/settings/datalets",
  );
});
