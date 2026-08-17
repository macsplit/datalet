import assert from "node:assert/strict";
import { test } from "node:test";
import {
  THEME_COLOR_ROLES,
  isThemeColorRole,
  themeCustomProperty,
  themeSettingsField,
  validThemeColor,
} from "../../src/utils/themeTokens.ts";
import { themeStylesheet } from "../../src/utils/themeStylesheet.ts";

test("accepted colour values round-trip and everything else is refused", () => {
  for (const accepted of [
    "#fff",
    "#FFFF",
    "#6d4de6",
    "#6d4de6cc",
    "rgb(12, 34, 56)",
    "rgba(12,34,56,0.5)",
    "hsl(240 60% 50%)",
    "hsla(240, 60%, 50%, 0.25)",
    "  #6d4de6  ",
  ]) {
    assert.equal(validThemeColor(accepted), accepted.trim(), `should accept ${accepted}`);
  }

  for (const refused of [
    // The reason this validator exists: a stored value must not be able to
    // cause an outbound request.
    "url(https://example.invalid/f.woff2)",
    "#fff; background-image: url(https://example.invalid/x.png)",
    "image-set('https://example.invalid/x.png')",
    // Escapes and comments can smuggle syntax past a naive pattern.
    "\\75 rl(https://example.invalid/x)",
    "#fff /* } */",
    "#fff}",
    "<script>",
    // Not colours at all.
    "red",
    "var(--color-bg)",
    "#ggg",
    "rgb(12, 34, 56",
    "",
    "   ",
    `#${"a".repeat(120)}`,
    undefined,
    null,
    42,
    { toString: () => "#fff" },
  ]) {
    assert.equal(validThemeColor(refused), undefined, `should refuse ${String(refused)}`);
  }
});

test("role names, custom properties and Settings fields stay in step", () => {
  assert.equal(themeCustomProperty("surface-alt"), "--color-surface-alt");
  assert.equal(themeSettingsField("surface-alt", "dark"), "themeColorSurfaceAltDark");
  assert.equal(themeSettingsField("bg", "light"), "themeColorBgLight");
  assert.ok(isThemeColorRole("accent"));
  // A role with a digit in it round-trips: heading-2 -> themeColorHeading2Light.
  assert.equal(themeSettingsField("heading-2", "light"), "themeColorHeading2Light");
  assert.equal(themeCustomProperty("heading-2"), "--color-heading-2");
  assert.ok(!isThemeColorRole("bg; background: url(x)"));

  // Every role must produce a distinct field for each scheme, or two roles
  // would silently share stored state.
  const fields = new Set(
    THEME_COLOR_ROLES.flatMap((role) => [
      themeSettingsField(role, "light"),
      themeSettingsField(role, "dark"),
    ]),
  );
  assert.equal(fields.size, THEME_COLOR_ROLES.length * 2);
});

test("the stylesheet keeps dark values inside a media query", () => {
  const css = themeStylesheet({
    themeColorBgLight: "#ffffff",
    themeColorBgDark: "#101014",
  });
  // The whole point of generating CSS rather than setting inline properties:
  // dark values must stay behind the media query so the system preference
  // still decides which palette applies.
  assert.match(css, /^:root \{\n {2}--color-bg: #ffffff;\n\}/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n:root \{\n {2}--color-bg: #101014;\n\}\n\}/);
});

test("invalid and absent values are equally absent from the stylesheet", () => {
  const css = themeStylesheet({
    themeColorBgLight: "#ffffff",
    themeColorTextLight: "url(https://example.invalid/x)",
    themeColorAccentLight: "definitely not a colour",
  });
  assert.match(css, /--color-bg: #ffffff;/);
  assert.doesNotMatch(css, /--color-text/);
  assert.doesNotMatch(css, /--color-accent/);
  assert.doesNotMatch(css, /example\.invalid/);
});

test("a theme that sets nothing valid produces no stylesheet at all", () => {
  assert.equal(themeStylesheet({}), "");
  assert.equal(themeStylesheet({ themeColorBgLight: "url(https://example.invalid/x)" }), "");
  assert.equal(themeStylesheet({ unrelatedField: "#ffffff" }), "");
});

test("only allowlisted custom properties can be emitted", () => {
  // A field naming a property outside the curated set must not reach the
  // stylesheet even when its value is a perfectly valid colour.
  const css = themeStylesheet({
    "themeColorBgLight": "#ffffff",
    "--color-anything": "#000000",
    "themeColorEvilLight": "#000000",
  });
  const emitted = [...css.matchAll(/--[a-z-]+(?=:)/g)].map((match) => match[0]);
  assert.deepEqual(emitted, ["--color-bg"]);
});
