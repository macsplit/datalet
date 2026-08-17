// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import type React from "react";
import { Link } from "@tanstack/react-router";
import { useSettings } from "../hooks/useSettings";
import {
  THEME_COLOR_ROLES,
  THEME_SCHEMES,
  validThemeColor,
  type ThemeColorRole,
  type ThemeScheme,
} from "../utils/themeTokens";

/** Human wording for a role, kept out of the token module so that stays data-only. */
const ROLE_LABELS: Record<ThemeColorRole, string> = {
  "bg": "Page background",
  "surface": "Panel background",
  "surface-alt": "Alternate panel",
  "border": "Borders",
  "text": "Body text",
  "text-muted": "Muted text",
  "text-subtle": "Subtle text",
  "accent": "Accent",
  "accent-hover": "Accent (hover)",
  "accent-text": "Accent text",
  "chip-bg": "Chip background",
  "chip-text": "Chip text",
  "badge-bg": "Badge background",
  "badge-text": "Badge text",
  "danger": "Danger",
  "success": "Success",
};

const SCHEME_LABELS: Record<ThemeScheme, string> = { light: "Light", dark: "Dark" };

/**
 * The `#rrggbb` a native colour input can show for a stored value, or
 * `undefined` when it cannot represent that value faithfully - an unset field,
 * or a functional notation like `rgba()`.
 *
 * `<input type="color">` speaks only `#rrggbb`, so it is a convenience for
 * choosing, never the record of what is stored: the text field beside it holds
 * the actual value, which is what keeps alpha and functional notations usable
 * and what makes "empty means the built-in colour" expressible at all. When
 * the picker cannot show the truth it is faded, because a control always has
 * *some* value and a confident black square would otherwise claim black was
 * chosen.
 */
function pickerValue(stored: string): string | undefined {
  const value = stored.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const shorthand = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (shorthand) return `#${shorthand.slice(1).map((c) => c + c).join("")}`;
  // An 8-digit hex carries alpha the picker cannot show, so the opaque part is
  // offered as a starting point rather than presented as the value.
  return undefined;
}

function ColorField({ role, scheme }: { role: ThemeColorRole; scheme: ThemeScheme }) {
  const { themeColor, setThemeColor } = useSettings();
  const stored = themeColor(role, scheme);
  const valid = validThemeColor(stored);
  const invalid = stored !== "" && valid === undefined;
  const inputId = `theme-${role}-${scheme}`;
  const exact = pickerValue(stored);

  return (
    <div className="field-group">
      <label className="field-label" htmlFor={inputId}>{SCHEME_LABELS[scheme]}</label>
      <div className="theme-color-row">
        <input
          type="color"
          className={`theme-color-picker${exact ? "" : " theme-color-picker-inexact"}`}
          aria-label={`${ROLE_LABELS[role]}, ${SCHEME_LABELS[scheme]} picker`}
          value={exact ?? "#000000"}
          onChange={(event) => setThemeColor(role, scheme, event.target.value)}
        />
        {/* Shows the stored value rather than the picker's approximation, so a
            translucent or functional colour looks like what it is, and an
            unset field reads as unset instead of as black. */}
        <span
          className={`theme-color-preview${valid ? "" : " theme-color-preview-unset"}`}
          // Passed as a custom property, not `background`, so the chequerboard
          // underneath survives and a translucent value looks translucent.
          // Only a value that already passed validThemeColor reaches here.
          style={valid ? ({ "--swatch": valid } as React.CSSProperties) : undefined}
          aria-hidden="true"
        />
        <input
          id={inputId}
          className="input"
          value={stored}
          placeholder="default"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-invalid={invalid || undefined}
          onChange={(event) => setThemeColor(role, scheme, event.target.value)}
        />
      </div>
      {invalid && (
        <span className="helper-text danger-text">
          Not a colour value — the built-in colour is being used.
        </span>
      )}
    </div>
  );
}

export function ThemePage() {
  const { resetTheme } = useSettings();

  return (
    <div className="page-content">
      <header className="page-hero">
        <h1>Theme</h1>
        <p>Choose the colours this app uses, for light and dark mode.</p>
      </header>
      <section className="panel">
        <header className="panel-header">
          <div>
            <p className="label-accent">Display</p>
            <h2 className="title">Colours</h2>
          </div>
          <button type="button" className="secondary-btn" onClick={resetTheme}>
            Reset theme
          </button>
        </header>
        <p className="helper-text">
          Colours are stored in the graph like your records, so a theme set here reaches
          your other devices and is included in a backup. Clear a field to keep the
          built-in colour. The dark column applies when your system asks for dark mode,
          so setting a theme does not stop the app following that preference.
        </p>
        <div className="section-stack">
          {THEME_COLOR_ROLES.map((role) => (
            <div className="field-group" key={role}>
              <span className="field-label">{ROLE_LABELS[role]}</span>
              <div className="layout-row">
                {THEME_SCHEMES.map((scheme) => (
                  <ColorField role={role} scheme={scheme} key={scheme} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <Link className="secondary-btn button-link" to="/settings">
        ← Back to Settings
      </Link>
    </div>
  );
}
