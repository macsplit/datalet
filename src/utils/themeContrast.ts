/**
 * A minimum-contrast floor for the theme, so a chosen colour cannot make the
 * app unreadable while it is being chosen.
 *
 * This is a floor, not a standard. It exists to stop the one catastrophic
 * case - text the same colour as what it sits on, which leaves nothing on
 * screen to fix it with - and otherwise leaves the choice alone. The built-in
 * `text-subtle` sits at 2.69:1 on its background, so anything stricter would
 * rewrite the shipped design the moment the app loaded; the floor is set below
 * that deliberately and `themeContrast.test.ts` asserts every default clears
 * it.
 */

import { THEME_COLOR_ROLES, type ThemeColorRole, type ThemeScheme } from "./themeTokens";

export const MIN_CONTRAST = 2.5;

/**
 * Which colours are read against which. Only text-on-background pairs; borders
 * and fills are decorative and are left entirely alone.
 */
const READABILITY_PAIRS: ReadonlyArray<readonly [ThemeColorRole, readonly ThemeColorRole[]]> = [
  ["text", ["bg", "surface"]],
  ["text-muted", ["bg", "surface"]],
  ["text-subtle", ["bg", "surface"]],
  ["accent-text", ["bg", "surface"]],
  ["danger", ["bg", "surface"]],
  ["success", ["bg", "surface"]],
  ["heading-2", ["bg", "surface"]],
  ["heading-3", ["bg", "surface"]],
  ["label", ["bg", "surface"]],
  ["chip-text", ["chip-bg"]],
  ["badge-text", ["badge-bg"]],
];

/**
 * The stylesheet's own values, duplicated here because a user-set colour has
 * to be checked against whatever it actually sits on, and an unset role is
 * only defined in CSS - the dark palette in particular cannot be read back
 * from the document while the browser is in light mode.
 * `themeContrast.test.ts` parses `global.css` and asserts this stays in step.
 */
export const THEME_DEFAULTS: Record<ThemeScheme, Record<ThemeColorRole, string>> = {
  light: {
    "bg": "#f5f5f6",
    "surface": "#ffffff",
    "surface-alt": "#f7f7f8",
    "border": "#e2e2e5",
    "text": "#18181b",
    "text-muted": "#6b6b72",
    "text-subtle": "#96969e",
    "accent": "#6d4de6",
    "accent-hover": "#5b3ddb",
    "accent-text": "#5b3ddb",
    "chip-bg": "#fde2f1",
    "chip-text": "#be185d",
    "badge-bg": "#d7f7ef",
    "badge-text": "#0d9488",
    "danger": "#dc2626",
    "success": "#16a34a",
    "heading-2": "#059669",
    "heading-3": "#0284c7",
    "label": "#a16207",
  },
  dark: {
    "bg": "#2a2b30",
    "surface": "#35363d",
    "surface-alt": "#3b3c44",
    "border": "#4b4c55",
    "text": "#f0f0f2",
    "text-muted": "#a3a3ab",
    "text-subtle": "#77777f",
    "accent": "#6f56d1",
    "accent-hover": "#7d66db",
    "accent-text": "#b9a6fb",
    "chip-bg": "#3a1930",
    "chip-text": "#f3a8da",
    "badge-bg": "#123832",
    "badge-text": "#5eead4",
    "danger": "#f87171",
    "success": "#16a34a",
    "heading-2": "#6ee7b7",
    "heading-3": "#7dd3fc",
    "label": "#fbbf24",
  },
};

type Rgb = { r: number; g: number; b: number; a: number };

function hueToChannel(p: number, q: number, t: number): number {
  const shifted = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
  if (shifted < 1 / 6) return p + (q - p) * 6 * shifted;
  if (shifted < 1 / 2) return q;
  if (shifted < 2 / 3) return p + (q - p) * (2 / 3 - shifted) * 6;
  return p;
}

/** Parse the colour forms `validThemeColor` admits. Anything else is undefined. */
export function parseColor(value: string): Rgb | undefined {
  const input = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(input);
  if (hex) {
    const digits = hex[1];
    const expand = (part: string) => parseInt(part.length === 1 ? part + part : part, 16);
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0]), g: expand(digits[1]), b: expand(digits[2]),
        a: digits.length === 4 ? expand(digits[3]) / 255 : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)), g: expand(digits.slice(2, 4)), b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
      };
    }
    return undefined;
  }

  const fn = /^(rgb|rgba|hsl|hsla)\(([^)]*)\)$/i.exec(input);
  if (!fn) return undefined;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return undefined;
  const alpha = parts.length > 3
    ? (parts[3].endsWith("%") ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]))
    : 1;
  if (!Number.isFinite(alpha)) return undefined;

  if (fn[1].toLowerCase().startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((part) =>
      part.endsWith("%") ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part));
    if (![r, g, b].every(Number.isFinite)) return undefined;
    return { r, g, b, a: alpha };
  }

  const hue = ((Number.parseFloat(parts[0]) % 360) + 360) % 360 / 360;
  const saturation = Number.parseFloat(parts[1]) / 100;
  const lightness = Number.parseFloat(parts[2]) / 100;
  if (![hue, saturation, lightness].every(Number.isFinite)) return undefined;
  if (saturation === 0) {
    const grey = lightness * 255;
    return { r: grey, g: grey, b: grey, a: alpha };
  }
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return {
    r: hueToChannel(p, q, hue + 1 / 3) * 255,
    g: hueToChannel(p, q, hue) * 255,
    b: hueToChannel(p, q, hue - 1 / 3) * 255,
    a: alpha,
  };
}

function channelLuminance(channel: number): number {
  const c = Math.min(255, Math.max(0, channel)) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** A translucent foreground is judged as it will actually be seen. */
function over(front: Rgb, back: Rgb): Rgb {
  if (front.a >= 1) return front;
  const blend = (f: number, b: number) => f * front.a + b * (1 - front.a);
  return { r: blend(front.r, back.r), g: blend(front.g, back.g), b: blend(front.b, back.b), a: 1 };
}

function ratioOf(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** WCAG contrast ratio between two colours, or `undefined` if either is unparseable. */
export function contrastRatio(foreground: string, background: string): number | undefined {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return undefined;
  return ratioOf(over(fg, bg), bg);
}

function format({ r, g, b, a }: Rgb): string {
  const round = (value: number) => Math.round(Math.min(255, Math.max(0, value)));
  return a >= 1
    ? `rgb(${round(r)}, ${round(g)}, ${round(b)})`
    : `rgba(${round(r)}, ${round(g)}, ${round(b)}, ${Number(a.toFixed(3))})`;
}

/**
 * Mix toward black (`target` 0) or white (`target` 255), keeping alpha.
 *
 * Channels are rounded here rather than on the way out, so the search measures
 * the colour that will actually be emitted. Searching on unrounded floats and
 * rounding afterwards lands just under the floor - the first version of this
 * settled at 2.4927 against a floor of 2.5.
 */
function mix(color: Rgb, target: number, amount: number): Rgb {
  const channel = (from: number) => Math.round(from + (target - from) * amount);
  return { r: channel(color.r), g: channel(color.g), b: channel(color.b), a: color.a };
}

function ratioWith(candidate: Rgb, fixed: Rgb, asForeground: boolean): number {
  const [fg, bg] = asForeground ? [candidate, fixed] : [fixed, candidate];
  return ratioOf(over(fg, bg), bg);
}

/**
 * Black or white, whichever this colour gains more contrast by moving toward.
 *
 * Deriving the direction from which colour is currently lighter looks
 * equivalent but is degenerate when the two match: black text on a black
 * background would be pushed toward black, and nothing would move.
 */
function bestTarget(moving: Rgb, fixed: Rgb, asForeground: boolean): number {
  const toBlack = ratioWith(mix(moving, 0, 1), fixed, asForeground);
  const toWhite = ratioWith(mix(moving, 255, 1), fixed, asForeground);
  return toBlack >= toWhite ? 0 : 255;
}

/**
 * The smallest movement toward black or white that clears the floor against
 * *every* background this colour is read on, or `undefined` when no movement
 * on either path can satisfy them all.
 *
 * A scan rather than a binary search: with more than one background the
 * worst-case ratio is not monotonic in the amount moved, so bisection can
 * settle on a point that satisfies one background and not another. Correcting
 * against each background in turn has the same fault - the second correction
 * undoes the first - which is what left a value at 2.4930 against a floor of
 * 2.5 until a sweep caught it.
 */
function moveForeground(fg: Rgb, backgrounds: Rgb[]): Rgb | undefined {
  const clears = (candidate: Rgb) =>
    backgrounds.every((bg) => ratioOf(over(candidate, bg), bg) >= MIN_CONTRAST);
  for (let step = 1; step <= 255; step += 1) {
    const amount = step / 255;
    for (const target of [0, 255]) {
      const candidate = mix(fg, target, amount);
      if (clears(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Push a background away from a foreground it cannot be read against. */
function moveBackground(bg: Rgb, fg: Rgb): Rgb {
  const target = ratioOf(over(fg, mix(bg, 0, 1)), mix(bg, 0, 1))
    >= ratioOf(over(fg, mix(bg, 255, 1)), mix(bg, 255, 1)) ? 0 : 255;
  for (let step = 1; step <= 255; step += 1) {
    const candidate = mix(bg, target, step / 255);
    if (ratioOf(over(fg, candidate), candidate) >= MIN_CONTRAST) return candidate;
  }
  return mix(bg, target, 1);
}

/**
 * Whether a colour is already at an extreme - every channel 00 or every
 * channel ff. Such a value cannot be pushed further without inverting it into
 * something the user plainly did not choose, so the other end of the pair
 * gives way instead.
 */
function atLimit(color: Rgb): boolean {
  return [color.r, color.g, color.b].every((channel) => Math.round(channel) === 0)
    || [color.r, color.g, color.b].every((channel) => Math.round(channel) === 255);
}

export type ContrastResult = {
  /** The palette actually emitted, with any correction applied. */
  colors: Record<string, string>;
  /** Roles whose value was moved to clear the floor. */
  adjusted: Set<ThemeColorRole>;
};

/**
 * Apply the floor to one scheme's palette.
 *
 * The foreground moves first, because a background is read against several
 * foregrounds while a foreground is read against one - correcting the shared
 * value to satisfy a single pair is how you break the others. Only when the
 * foreground has run out of room, sitting at pure black or pure white and
 * still short, does the background move instead.
 */
export function enforceContrast(
  scheme: ThemeScheme,
  stored: Record<string, string>,
): ContrastResult {
  const colors: Record<string, string> = { ...THEME_DEFAULTS[scheme], ...stored };
  const adjusted = new Set<ThemeColorRole>();

  // Bounded because moving a background re-opens every pair that reads against
  // it. Both moves push monotonically toward an extreme, so this settles; the
  // bound is a guard, not the mechanism.
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const [foreground, backgrounds] of READABILITY_PAIRS) {
      const fg = parseColor(colors[foreground] ?? "");
      // An unparseable value never reached the stylesheet either, so there is
      // nothing here to correct.
      if (!fg) continue;
      const backs = backgrounds
        .map((role) => ({ role, color: parseColor(colors[role] ?? "") }))
        .filter((entry): entry is { role: ThemeColorRole; color: Rgb } => entry.color !== undefined);
      if (backs.length === 0) continue;

      const failing = backs.filter(({ color }) => ratioOf(over(fg, color), color) < MIN_CONTRAST);
      if (failing.length === 0) continue;

      // The foreground moves first: it is read against these backgrounds
      // alone, while a background is read against several foregrounds, so
      // correcting the shared value is how the others get broken.
      const moved = atLimit(fg) ? undefined : moveForeground(fg, backs.map(({ color }) => color));
      if (moved) {
        colors[foreground] = format(moved);
        adjusted.add(foreground);
      } else {
        // Either the chosen value sits at 00 or ff, or no single foreground
        // can be read on all of these backgrounds. Either way the other end
        // gives way and the choice survives.
        for (const { role, color } of failing) {
          colors[role] = format(moveBackground(color, fg));
          adjusted.add(role);
        }
      }
      changed = true;
    }
    if (!changed) break;
  }

  // Roles the user never set are reported as their default, not as an
  // adjustment of something they chose.
  for (const role of THEME_COLOR_ROLES) {
    if (!(role in stored) && colors[role] === THEME_DEFAULTS[scheme][role]) adjusted.delete(role);
  }
  return { colors, adjusted };
}
