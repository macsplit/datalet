import { expect, test } from "@playwright/test";

const STORE_KEY = "meta-ui-builder:ng-local-store";
const INDEX_KEY = `${STORE_KEY}:index`;
const RECORD_PREFIX = `${STORE_KEY}:record:`;
const SESSION_KEY = "meta-ui-builder:local-session";
const GRAPH = "did:ng:test-private-store";
const SETTINGS_ID = "did:ng:z:SettingsSingleton";

/** Seed a Settings record carrying `theme`, so a stored theme exists before first paint. */
async function seedTheme(page: import("@playwright/test").Page, theme: Record<string, string>) {
  await page.addInitScript(({ theme, indexKey, prefix, sessionKey, graph, settingsId }) => {
    // addInitScript runs on every navigation, so seeding unconditionally would
    // wipe the page's own writes on reload and make persistence untestable.
    if (localStorage.getItem("theme-test-seeded")) return;
    localStorage.clear();
    localStorage.setItem("theme-test-seeded", "1");
    localStorage.setItem(sessionKey, JSON.stringify({
      session_id: "theme-test-session",
      private_store_id: "test-private-store",
    }));
    const record = {
      "@graph": graph,
      "@id": settingsId,
      "@type": "did:ng:z:Settings",
      appTitle: "Themed",
      ...theme,
    };
    const key = `${graph}|${settingsId}`;
    localStorage.setItem(`${prefix}${key}`, JSON.stringify(record));
    localStorage.setItem(indexKey, JSON.stringify([key]));
  }, { theme, indexKey: INDEX_KEY, prefix: RECORD_PREFIX, sessionKey: SESSION_KEY, graph: GRAPH, settingsId: SETTINGS_ID });
}

const backgroundOf = (page: import("@playwright/test").Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("a stored theme colours the app", async ({ page }) => {
  await seedTheme(page, { themeColorBgLight: "#123456" });
  await page.goto("/");
  await expect.poll(() => backgroundOf(page)).toBe("rgb(18, 52, 86)");
});

test("a dark value never leaks into light mode", async ({ page }) => {
  // This is the regression that justifies generating a stylesheet instead of
  // setting inline custom properties. An inline property beats a media query,
  // so writing both palettes that way leaves whichever was written last in
  // force — the dark colour would apply in light mode. Asserting the dark
  // case instead would pass under that bug, because writing dark last happens
  // to be right there.
  await seedTheme(page, {
    themeColorBgLight: "#ffffff",
    themeColorBgDark: "#101014",
  });
  await page.goto("/");
  await expect.poll(() => backgroundOf(page)).toBe("rgb(255, 255, 255)");
});

test.describe("with the system asking for dark mode", () => {
  test.use({ colorScheme: "dark" });

  test("the dark palette applies and the light one does not", async ({ page }) => {
    // The regression that justifies generating a stylesheet instead of setting
    // inline custom properties: an inline property beats a media query, so the
    // obvious implementation makes a themed app stop following the system
    // preference — and only for users who set a theme.
    await seedTheme(page, {
      themeColorBgLight: "#ffffff",
      themeColorBgDark: "#101014",
    });
    await page.goto("/");
    await expect.poll(() => backgroundOf(page)).toBe("rgb(16, 16, 20)");
  });

  test("a light-only theme leaves dark mode at its built-in colour", async ({ page }) => {
    await seedTheme(page, { themeColorBgLight: "#ffffff" });
    await page.goto("/");
    // Not white: the stylesheet's own dark value still applies.
    await expect.poll(() => backgroundOf(page)).not.toBe("rgb(255, 255, 255)");
  });
});

test("a hostile theme value cannot make the app fetch anything", async ({ page }) => {
  // A theme arrives through JSON import and through a shared vault, so a value
  // may have been chosen by someone else. This is the test that encodes why
  // URLs are refused rather than sanitised.
  const external: string[] = [];
  await page.route("**://example.invalid/**", (route) => {
    external.push(route.request().url());
    return route.abort();
  });
  await seedTheme(page, {
    themeColorBgLight: "url(https://example.invalid/x.png)",
    themeColorTextLight: "#ff0000; background-image: url(https://example.invalid/y.png)",
  });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();

  expect(external).toEqual([]);
  const injected = await page.evaluate(() =>
    document.getElementById("graph-theme")?.textContent ?? "");
  expect(injected).not.toContain("example.invalid");
  // The valid part of a poisoned value is not salvaged either — the whole
  // value fails, so the role keeps its built-in colour.
  expect(injected).not.toContain("--color-text");
});

test("editing a colour applies live, persists, and resets", async ({ page }) => {
  await seedTheme(page, {});
  await page.goto("/settings/theme");

  await page.getByLabel("Light", { exact: true }).first().fill("#204060");
  await expect.poll(() => backgroundOf(page)).toBe("rgb(32, 64, 96)");

  await page.reload();
  await expect.poll(() => backgroundOf(page)).toBe("rgb(32, 64, 96)");

  await page.getByRole("button", { name: "Reset theme" }).click();
  await expect.poll(() => backgroundOf(page)).not.toBe("rgb(32, 64, 96)");
});

test("an unparseable stored colour is flagged rather than silently ignored", async ({ page }) => {
  await seedTheme(page, { themeColorBgLight: "not a colour" });
  await page.goto("/settings/theme");
  await expect(page.getByText("Not a colour value").first()).toBeVisible();
});

test("a theme reaches a second tab and a backup export", async ({ page, context }) => {
  await seedTheme(page, {});
  await page.goto("/settings/theme");
  await page.getByLabel("Light", { exact: true }).first().fill("#0a0b0c");
  await expect.poll(() => backgroundOf(page)).toBe("rgb(10, 11, 12)");

  const second = await context.newPage();
  await second.goto("/");
  await expect.poll(() => backgroundOf(second)).toBe("rgb(10, 11, 12)");
  await second.close();

  const stored = await page.evaluate(({ prefix, graph, settingsId }) =>
    localStorage.getItem(`${prefix}${graph}|${settingsId}`),
    { prefix: RECORD_PREFIX, graph: GRAPH, settingsId: SETTINGS_ID });
  expect(stored).toContain("themeColorBgLight");
  expect(stored).toContain("#0a0b0c");
});

test("the theme lives on its own page, reached from Settings", async ({ page }) => {
  await seedTheme(page, {});
  await page.goto("/settings");
  // Settings should describe the theme, not contain its sixteen colour rows.
  await expect(page.getByLabel("Light", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Choose colours" }).click();
  await expect(page.getByRole("heading", { name: "Theme" })).toBeVisible();
  await expect(page.getByLabel("Light", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Back to Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

const swatchOf = (page: import("@playwright/test").Page, nth: number) =>
  page.locator(".theme-color-swatch").nth(nth).evaluate((node) => ({
    swatch: getComputedStyle(node).getPropertyValue("--swatch").trim(),
    unset: node.classList.contains("theme-color-swatch-unset"),
  }));

test("the swatch is the picker, and shows what will be on screen", async ({ page }) => {
  await seedTheme(page, {});
  await page.goto("/settings/theme");

  const picker = page.getByLabel("Page background, Light", { exact: true });
  const text = page.getByLabel("Light", { exact: true }).first();

  // The colour input sits inside the swatch, so choosing through it writes a
  // plain hex and the square it is laid over shows that colour.
  await picker.fill("#3366cc");
  await expect(text).toHaveValue("#3366cc");
  await expect.poll(() => backgroundOf(page)).toBe("rgb(51, 102, 204)");
  expect(await swatchOf(page, 0)).toEqual({ swatch: "#3366cc", unset: false });

  // A value the picker cannot express survives, and the swatch still shows it
  // — which is the reason the square is not just the input's own rendering.
  await text.fill("rgba(10, 20, 30, 0.5)");
  await expect(text).toHaveValue("rgba(10, 20, 30, 0.5)");
  await expect(picker).toHaveValue("#000000");
  expect(await swatchOf(page, 0)).toEqual({ swatch: "rgba(10, 20, 30, 0.5)", unset: false });
  await expect.poll(() => backgroundOf(page)).toBe("rgba(10, 20, 30, 0.5)");
});

test("the swatch shows nothing when unset or unusable", async ({ page }) => {
  await seedTheme(page, { themeColorBgLight: "#3366cc" });
  await page.goto("/settings/theme");

  // First row is the page background: light is set, dark is not.
  expect(await swatchOf(page, 0)).toEqual({ swatch: "#3366cc", unset: false });
  expect(await swatchOf(page, 1)).toEqual({ swatch: "", unset: true });

  // An invalid value is shown as unset rather than as some arbitrary colour.
  await page.getByLabel("Light", { exact: true }).first().fill("nonsense");
  expect(await swatchOf(page, 0)).toEqual({ swatch: "", unset: true });
});

test("a per-colour reset returns just that one to its default", async ({ page }) => {
  await seedTheme(page, { themeColorBgLight: "#3366cc", themeColorTextLight: "#112233" });
  await page.goto("/settings/theme");
  await expect.poll(() => backgroundOf(page)).toBe("rgb(51, 102, 204)");

  await page.getByRole("button", { name: "Reset Page background, Light to default" }).click();

  await expect(page.locator("#theme-bg-light")).toHaveValue("");
  await expect.poll(() => backgroundOf(page)).not.toBe("rgb(51, 102, 204)");
  // The other colour is untouched: this resets one item, not the theme.
  await expect(page.locator("#theme-text-light")).toHaveValue("#112233");
});

test("a role with a digit in its name persists", async ({ page }) => {
  // heading-2 maps to themeColorHeading2Light. An earlier field-name transform
  // left the hyphen in, producing a name the shape does not declare, so the
  // colour was accepted in the UI and silently never stored.
  await seedTheme(page, {});
  await page.goto("/settings/theme");
  await page.locator("#theme-heading-2-light").fill("#884400");
  await page.reload();
  await expect(page.locator("#theme-heading-2-light")).toHaveValue("#884400");
  const stored = await page.evaluate(({ prefix, graph, settingsId }) =>
    localStorage.getItem(`${prefix}${graph}|${settingsId}`),
    { prefix: RECORD_PREFIX, graph: GRAPH, settingsId: SETTINGS_ID });
  expect(stored).toContain("themeColorHeading2Light");
});

test("a colour that would be unreadable is moved, and says so", async ({ page }) => {
  // Neither value is at an extreme, so the text moves rather than the shared
  // background — and the swatch shows the moved colour, not the typed one.
  await seedTheme(page, { themeColorTextLight: "#fafafa", themeColorBgLight: "#fbfbfb" });
  await page.goto("/settings/theme");

  await expect(page.getByText("Lightened or darkened to stay readable").first()).toBeVisible();
  const applied = await page.evaluate(() => getComputedStyle(document.body).color);
  expect(applied).not.toBe("rgb(250, 250, 250)");
});
