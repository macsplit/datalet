import { expect, test } from "@playwright/test";

test("the current destination is marked with a straight bar, not a curved border", async ({ page }) => {
  // The icon links are rounded hit targets. Colouring their bottom border to
  // mark the current page draws the line around the corner radius, so it
  // curves up and thins out at both ends and reads as a smear. The bar is a
  // separate element instead. Worth asserting because the shared
  // `.app-nav-links a.active` rule also matches these links: it silently
  // re-coloured the border once already while this was being fixed.
  await page.goto("/settings");
  const current = page.locator(".app-nav-links a.nav-icon-link.active");
  await expect(current).toHaveCount(1);

  const marker = await current.evaluate((node) => {
    const border = getComputedStyle(node).borderBottomColor;
    const bar = getComputedStyle(node, "::after");
    return {
      border,
      barHeight: bar.height,
      barColor: bar.backgroundColor,
      radius: getComputedStyle(node).borderBottomLeftRadius,
    };
  });

  // Transparent covers both `transparent` and a zero-alpha rgba serialisation.
  expect(marker.border).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
  expect(marker.barHeight).toBe("2px");
  expect(marker.barColor).not.toBe("rgba(0, 0, 0, 0)");
  // The rounding is what made a bottom border wrong here; if it ever goes away
  // the bar is still correct, but this records why the bar exists.
  expect(marker.radius).not.toBe("0px");
});
