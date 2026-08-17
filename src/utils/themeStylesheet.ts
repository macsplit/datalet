/**
 * Turns a stored theme into a stylesheet.
 *
 * The important decision here is that this generates CSS text containing a
 * real `@media (prefers-color-scheme: dark)` block, rather than calling
 * `documentElement.style.setProperty`. An inline property beats a media query,
 * so the setProperty approach silently stops the app following the system
 * colour scheme - and only for users who have set a theme, which is exactly
 * the kind of fault nobody connects back to its cause. Emitting a stylesheet
 * removes the possibility instead of documenting it.
 */

import {
  THEME_COLOR_ROLES,
  THEME_SCHEMES,
  themeCustomProperty,
  themeSettingsField,
  validThemeColor,
  type ThemeColorRole,
  type ThemeScheme,
} from "./themeTokens";
import { enforceContrast, THEME_DEFAULTS } from "./themeContrast";

export const THEME_STYLE_ELEMENT_ID = "graph-theme";

/** Values keyed by Settings field name, as read off the Settings record. */
export type StoredTheme = Record<string, unknown>;

/** The roles a stored theme validly sets for one scheme. */
export function storedColorsFor(
  theme: StoredTheme,
  scheme: ThemeScheme,
): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const role of THEME_COLOR_ROLES) {
    const value = validThemeColor(theme[themeSettingsField(role, scheme)]);
    // An invalid or absent value is simply not recorded, leaving the token at
    // its stylesheet default. The two cases are deliberately indistinguishable.
    if (value !== undefined) colors[role] = value;
  }
  return colors;
}

/**
 * What a scheme will actually render as, once the contrast floor has been
 * applied. Exposed so the settings page can show a value that was moved
 * rather than leaving the user to wonder why the screen disagrees with the
 * field.
 */
export function effectiveColorsFor(theme: StoredTheme, scheme: ThemeScheme) {
  return enforceContrast(scheme, storedColorsFor(theme, scheme));
}

function declarationsFor(theme: StoredTheme, scheme: ThemeScheme): string[] {
  const stored = storedColorsFor(theme, scheme);
  const { colors } = enforceContrast(scheme, stored);
  const declarations: string[] = [];
  for (const role of THEME_COLOR_ROLES) {
    // Only roles the theme actually touches are emitted. A role the contrast
    // pass moved is emitted too, even if the user never set it - that is the
    // background giving way when a foreground had nowhere left to go.
    const isSet = role in stored;
    const moved = colors[role] !== THEME_DEFAULTS[scheme][role as ThemeColorRole];
    if (isSet || moved) declarations.push(`${themeCustomProperty(role)}: ${colors[role]};`);
  }
  return declarations;
}

/**
 * The CSS for a stored theme, or an empty string when it sets nothing valid -
 * in which case callers remove the style element rather than leaving an empty
 * one behind.
 */
export function themeStylesheet(theme: StoredTheme): string {
  const blocks: string[] = [];
  for (const scheme of THEME_SCHEMES) {
    const declarations = declarationsFor(theme, scheme);
    if (declarations.length === 0) continue;
    const rule = `:root {\n  ${declarations.join("\n  ")}\n}`;
    blocks.push(scheme === "dark" ? `@media (prefers-color-scheme: dark) {\n${rule}\n}` : rule);
  }
  return blocks.join("\n");
}

/**
 * Apply a stored theme to the document. Rewrites one style element rather than
 * appending, so repeated calls cannot accumulate stale rules.
 */
export function applyThemeToDocument(theme: StoredTheme, doc: Document = document): void {
  const css = themeStylesheet(theme);
  const existing = doc.getElementById(THEME_STYLE_ELEMENT_ID);
  if (css.length === 0) {
    existing?.remove();
    return;
  }
  const element = existing ?? doc.createElement("style");
  if (!existing) {
    element.id = THEME_STYLE_ELEMENT_ID;
    // Appended to <head> so it follows the linked stylesheet and wins on order
    // rather than on specificity - both define the same custom properties on
    // :root, so the later one applies.
    doc.head.append(element);
  }
  if (element.textContent !== css) element.textContent = css;
}
