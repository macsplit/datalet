/**
 * The curated set of CSS custom properties a stored theme may set, and the
 * validation every stored value passes before it reaches a stylesheet.
 *
 * The graph is untrusted input. A theme arrives through JSON import and
 * through a vault whose token another person may hold, so a value is a string
 * someone else may have chosen. Nothing here is spliced into CSS without
 * matching an allowlisted name and a strict value grammar first - the same
 * discipline `sanitizeLabel` applies before splicing a label into Cypher.
 *
 * `src/styles/global.css` defines 228 custom properties. Only colour roles are
 * exposed: they change appearance, whereas spacing and type-scale tokens
 * change layout, and a stored value that breaks the layout is far harder for a
 * user to recognise and undo than a bad colour.
 */

/** A colour role, named for what it does rather than what it looks like. */
export const THEME_COLOR_ROLES = [
  "bg",
  "surface",
  "surface-alt",
  "border",
  "text",
  "text-muted",
  "text-subtle",
  "accent",
  "accent-hover",
  "accent-text",
  "chip-bg",
  "chip-text",
  "badge-bg",
  "badge-text",
  "danger",
  "success",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];

/** Both palettes a theme carries; dark is not derived from light. */
export const THEME_SCHEMES = ["light", "dark"] as const;
export type ThemeScheme = (typeof THEME_SCHEMES)[number];

/** The CSS custom property a role maps to, e.g. `surface-alt` → `--color-surface-alt`. */
export function themeCustomProperty(role: ThemeColorRole): string {
  return `--color-${role}`;
}

/**
 * The Settings field a role/scheme pair is stored in, e.g.
 * `surface-alt` + `dark` → `themeColorSurfaceAltDark`. Derived rather than
 * listed so the shape, the UI and the stylesheet cannot drift apart.
 */
export function themeSettingsField(role: ThemeColorRole, scheme: ThemeScheme): string {
  const camel = role.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const capitalized = camel.charAt(0).toUpperCase() + camel.slice(1);
  return `themeColor${capitalized}${scheme === "dark" ? "Dark" : "Light"}`;
}

const ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);

/** Whether `role` is one of the roles a theme is allowed to set. */
export function isThemeColorRole(role: string): role is ThemeColorRole {
  return ROLE_SET.has(role);
}

// A value is only ever a colour, so the grammar is closed rather than
// permissive: three hex forms, or one of four functional notations whose
// arguments are numeric. Anything else - including every CSS-valid construct
// that can fetch, comment out the rest of a rule, or escape the declaration -
// fails by not matching.
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla)\(\s*[-0-9a-z.%,\s/]+\)$/i;

// Rejected before the grammar runs, so a value that somehow satisfied both is
// still refused. `url(` and `image-set(` fetch; `\` escapes; `/*` comments;
// `;` and `}` end the declaration or the rule.
const FORBIDDEN = /url\(|image-set\(|expression\(|\\|\/\*|;|\}|<|>/i;

const MAX_VALUE_LENGTH = 64;

/**
 * A stored colour, or `undefined` if it is not one. Callers drop an invalid
 * value rather than substituting a default: the token then falls back to the
 * stylesheet, which is what an absent field already means, so a bad value and
 * a missing one behave identically.
 */
export function validThemeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VALUE_LENGTH) return undefined;
  if (FORBIDDEN.test(trimmed)) return undefined;
  if (!HEX.test(trimmed) && !FUNCTIONAL.test(trimmed)) return undefined;
  return trimmed;
}
