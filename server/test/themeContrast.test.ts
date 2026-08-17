import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MIN_CONTRAST,
  THEME_DEFAULTS,
  contrastRatio,
  enforceContrast,
  parseColor,
} from "../../src/utils/themeContrast.ts";
import { THEME_COLOR_ROLES, THEME_SCHEMES } from "../../src/utils/themeTokens.ts";
import { themeStylesheet } from "../../src/utils/themeStylesheet.ts";

const cssPath = fileURLToPath(new URL("../../src/styles/global.css", import.meta.url));

test("the duplicated default palette matches the stylesheet", () => {
  // enforceContrast has to know what an unset role actually renders as, and
  // the dark palette cannot be read back from a light-mode document. That
  // makes the table a second source of truth, so it is pinned to the first.
  const css = readFileSync(cssPath, "utf8");
  const block = (pattern: RegExp) => {
    const found = pattern.exec(css);
    assert(found, `could not find ${pattern}`);
    return Object.fromEntries(
      [...found[0].matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)]
        .map((match) => [match[1], match[2]]),
    );
  };
  const fromCss = {
    light: block(/:root \{[\s\S]*?\n\}/),
    dark: block(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\s*\}\n\}/),
  };
  for (const scheme of THEME_SCHEMES) {
    for (const role of THEME_COLOR_ROLES) {
      assert.equal(
        THEME_DEFAULTS[scheme][role],
        fromCss[scheme][role],
        `${role} (${scheme}) drifted from global.css`,
      );
    }
  }
});

test("every colour the interface paints with is offered to the user", () => {
  // The curated set originally missed --color-label and the two heading
  // colours, so the page showed colours it gave no way to change. Any custom
  // property the stylesheet actually reads through var() has to be a role.
  const css = readFileSync(cssPath, "utf8");
  const used = new Set(
    [...css.matchAll(/var\(--color-([a-z0-9-]+)/g)].map((match) => match[1]),
  );
  // Deliberately not offered: decorative fills that no text is read against.
  const notOffered = new Set(["danger-soft-bg", "success-hover"]);
  const missing = [...used].filter(
    (role) => !notOffered.has(role) && !(THEME_COLOR_ROLES as readonly string[]).includes(role),
  );
  assert.deepEqual(missing.sort(), [], `these are painted but cannot be changed: ${missing}`);
});

test("every built-in pairing already clears the floor", () => {
  // If it did not, the app would rewrite its own palette on first load. This
  // is what fixes the floor below the built-in text-subtle rather than at some
  // rounder number.
  for (const scheme of THEME_SCHEMES) {
    const { adjusted } = enforceContrast(scheme, {});
    assert.deepEqual([...adjusted], [], `${scheme} defaults should need no correction`);
  }
});

test("contrast is computed over the background for a translucent colour", () => {
  assert.equal(contrastRatio("#000000", "#ffffff")?.toFixed(2), "21.00");
  assert.equal(contrastRatio("#ffffff", "#ffffff")?.toFixed(2), "1.00");
  // Barely-there black over white reads as white, not as black.
  const faint = contrastRatio("rgba(0, 0, 0, 0.02)", "#ffffff");
  assert.ok(faint !== undefined && faint < 1.2, `expected near-1, got ${faint}`);
  assert.equal(contrastRatio("not a colour", "#ffffff"), undefined);
});

test("colour forms parse equivalently", () => {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  assert.deepEqual(parseColor("#fff"), white);
  assert.deepEqual(parseColor("#ffffff"), white);
  assert.deepEqual(parseColor("rgb(255, 255, 255)"), white);
  assert.deepEqual(parseColor("hsl(0, 0%, 100%)"), white);
  const half = parseColor("hsl(120, 100%, 50%)");
  assert.ok(half && Math.round(half.g) === 255 && Math.round(half.r) === 0);
});

test("text that would vanish into its background is moved apart", () => {
  // The case the floor exists for: nothing left on screen to fix it with.
  // Neither value is at an extreme, so the foreground moves - it is read
  // against one background, while a background is read against several.
  const { colors, adjusted } = enforceContrast("light", { text: "#fafafa", bg: "#fbfbfb" });
  assert.ok(adjusted.has("text"), "the foreground should be the one that moves");
  assert.ok(!adjusted.has("bg"), "the shared background should be left alone");
  assert.equal(colors.bg, "#fbfbfb");
  const ratio = contrastRatio(colors.text, colors.bg);
  assert.ok(ratio !== undefined && ratio >= MIN_CONTRAST, `got ${ratio}`);
});

test("the background gives way when the foreground is already at a limit", () => {
  // A value at 00 or ff cannot be pushed further without inverting it into
  // something plainly not chosen, so the other end moves instead - and the
  // chosen value survives exactly.
  for (const extreme of ["#ffffff", "#000000"]) {
    const { colors, adjusted } = enforceContrast("light", { text: extreme, bg: extreme });
    assert.ok(adjusted.has("bg"), `expected the background to move for ${extreme}`);
    assert.ok(!adjusted.has("text"), `expected ${extreme} to be kept`);
    assert.equal(colors.text, extreme);
    const ratio = contrastRatio(colors.text, colors.bg);
    assert.ok(ratio !== undefined && ratio >= MIN_CONTRAST, `got ${ratio}`);
  }
});

test("a comfortable choice is left exactly as chosen", () => {
  const chosen = { text: "#102030", bg: "#fefefe", accent: "#ff00ff" };
  const { colors, adjusted } = enforceContrast("light", chosen);
  assert.deepEqual([...adjusted], []);
  for (const [role, value] of Object.entries(chosen)) assert.equal(colors[role], value);
});

test("a corrected value reaches the stylesheet, and only touched roles are emitted", () => {
  const css = themeStylesheet({ themeColorTextLight: "#fafafa", themeColorBgLight: "#fbfbfb" });
  // Untouched roles stay out of the generated CSS entirely.
  assert.doesNotMatch(css, /--color-accent:/);
  const emittedText = /--color-text:\s*([^;]+);/.exec(css);
  const emittedBg = /--color-bg:\s*([^;]+);/.exec(css);
  assert(emittedText && emittedBg);
  assert.notEqual(emittedText[1].trim(), "#fafafa", "the correction should be what ships");
  assert.equal(emittedBg[1].trim(), "#fbfbfb");
  const ratio = contrastRatio(emittedText[1].trim(), emittedBg[1].trim());
  assert.ok(ratio !== undefined && ratio >= MIN_CONTRAST, `got ${ratio}`);
});

test("a background moved on a foreground's behalf still reaches the stylesheet", () => {
  // The user set only the text. The background it sits on has to move, so a
  // role the theme never mentions still has to be emitted.
  const css = themeStylesheet({ themeColorTextLight: "#ffffff" });
  const emittedBg = /--color-bg:\s*([^;]+);/.exec(css);
  assert(emittedBg, "the background should be emitted even though it was never set");
  const ratio = contrastRatio("#ffffff", emittedBg[1].trim());
  assert.ok(ratio !== undefined && ratio >= MIN_CONTRAST, `got ${ratio}`);
});

/** Every pair the enforcer is responsible for, checked directly. */
function worstPairRatio(colors: Record<string, string>): number {
  const pairs: Array<[string, string]> = [
    ["text", "bg"], ["text", "surface"],
    ["text-muted", "bg"], ["text-muted", "surface"],
    ["text-subtle", "bg"], ["text-subtle", "surface"],
    ["accent-text", "bg"], ["accent-text", "surface"],
    ["danger", "bg"], ["danger", "surface"],
    ["success", "bg"], ["success", "surface"],
    ["chip-text", "chip-bg"], ["badge-text", "badge-bg"],
  ];
  let worst = Infinity;
  for (const [fg, bg] of pairs) {
    const ratio = contrastRatio(colors[fg], colors[bg]);
    if (ratio !== undefined) worst = Math.min(worst, ratio);
  }
  return worst;
}

test("a sweep of hostile choices always ends above the floor", () => {
  // Examples only prove the cases someone thought of. This walks the whole
  // greyscale for both ends of a pair, which is where a fixed iteration bound
  // or a bad direction choice would show up.
  const steps = [0, 1, 8, 32, 64, 96, 118, 128, 138, 160, 192, 224, 247, 254, 255];
  const hex = (v: number) => `#${v.toString(16).padStart(2, "0").repeat(3)}`;
  for (const scheme of THEME_SCHEMES) {
    for (const fg of steps) {
      for (const bg of steps) {
        const { colors } = enforceContrast(scheme, { text: hex(fg), bg: hex(bg) });
        const ratio = contrastRatio(colors.text, colors.bg);
        assert.ok(
          ratio !== undefined && ratio >= MIN_CONTRAST,
          `${scheme} text ${hex(fg)} on bg ${hex(bg)} settled at ${ratio}`,
        );
      }
    }
  }
});

test("a sweep of saturated choices leaves no pair below the floor", () => {
  // Not just the pair that was set: correcting one must not push another under.
  const hues = [0, 40, 80, 130, 190, 240, 290, 330];
  for (const scheme of THEME_SCHEMES) {
    for (const hue of hues) {
      for (const lightness of [8, 30, 50, 70, 95]) {
        const { colors } = enforceContrast(scheme, {
          bg: `hsl(${hue}, 90%, ${lightness}%)`,
          surface: `hsl(${hue}, 60%, ${lightness}%)`,
        });
        const worst = worstPairRatio(colors);
        assert.ok(
          worst >= MIN_CONTRAST,
          `${scheme} hue ${hue} lightness ${lightness}% left a pair at ${worst}`,
        );
      }
    }
  }
});

test("correcting is idempotent", () => {
  // The stylesheet is regenerated on every render, so a correction that drifted
  // each time would walk a colour to black or white over a session.
  for (const stored of [
    { text: "#fafafa", bg: "#fbfbfb" },
    { text: "#ffffff", bg: "#ffffff" },
    { text: "#808080", bg: "#7f7f7f" },
    { "chip-text": "#123456", "chip-bg": "#123456" },
  ]) {
    const once = enforceContrast("light", stored);
    const twice = enforceContrast("light", once.colors);
    assert.deepEqual(twice.colors, once.colors, `not idempotent for ${JSON.stringify(stored)}`);
  }
});

test("a translucent choice keeps its alpha through a correction", () => {
  const { colors } = enforceContrast("light", { text: "rgba(250, 250, 250, 0.6)", bg: "#ffffff" });
  assert.match(colors.text, /^rgba\(/, `expected alpha to survive, got ${colors.text}`);
  const ratio = contrastRatio(colors.text, colors.bg);
  assert.ok(ratio !== undefined && ratio >= MIN_CONTRAST, `got ${ratio}`);
});

test("an unparseable value is left for the validator to drop, not corrected", () => {
  const { colors, adjusted } = enforceContrast("light", { text: "url(https://example.invalid/x)" });
  assert.equal(colors.text, "url(https://example.invalid/x)");
  assert.deepEqual([...adjusted], []);
  // It never reaches CSS, because the validator refuses it first.
  assert.doesNotMatch(themeStylesheet({ themeColorTextLight: "url(https://example.invalid/x)" }), /example/);
});

test("roles outside a readability pair are never touched", () => {
  // Borders and fills are decorative. Correcting them would be the nannying
  // this floor is deliberately not doing.
  const { colors, adjusted } = enforceContrast("light", {
    border: "#fefefe",
    "surface-alt": "#ffffff",
    accent: "#fdfdfd",
  });
  assert.deepEqual([...adjusted], []);
  assert.equal(colors.border, "#fefefe");
  assert.equal(colors["surface-alt"], "#ffffff");
  assert.equal(colors.accent, "#fdfdfd");
});
