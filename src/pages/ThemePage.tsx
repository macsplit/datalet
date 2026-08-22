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
import { effectiveColorsFor } from "../utils/themeStylesheet";
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
  "accent": "Accent",
  "accent-hover": "Accent (hover)",
  "accent-text": "Accent text",
  "chip-bg": "Chip background",
  "chip-text": "Chip text",
  "badge-bg": "Badge background",
  "badge-text": "Badge text",
  "danger": "Danger",
  "success": "Success",
  "heading-2": "Section heading",
  "heading-3": "Sub-heading",
  "label": "Small caps label",
};

const SCHEME_LABELS: Record<ThemeScheme, string> = { light: "Light", dark: "Dark" };

/**
 * The `#rrggbb` to open the native picker at, or `undefined` when the stored
 * value cannot be expressed as one - an unset field, or a functional notation
 * like `rgba()`.
 *
 * The picker only ever seeds the dialog; what is shown is the swatch behind
 * it, and what is stored is the text field beside it. That division is what
 * keeps alpha and functional notations usable, and what makes "empty means the
 * built-in colour" expressible at all - none of which `<input type="color">`
 * can represent.
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

function ColorField({
  role,
  scheme,
  effective,
  adjusted,
}: {
  role: ThemeColorRole;
  scheme: ThemeScheme;
  effective: string;
  adjusted: boolean;
}) {
  const { themeColor, setThemeColor } = useSettings();
  const stored = themeColor(role, scheme);
  const valid = validThemeColor(stored);
  const invalid = stored !== "" && valid === undefined;
  const inputId = `theme-${role}-${scheme}`;
  const exact = pickerValue(stored);
  // The preview shows what will actually be on screen, so a value the contrast
  // floor moved does not leave the square disagreeing with the app.
  const previewed = valid ? effective : undefined;

  return (
    <div className="field-group">
      <label className="field-label" htmlFor={inputId}>{SCHEME_LABELS[scheme]}</label>
      <div className="theme-color-row">
        {/* One control: the square shows the colour that will actually be on
            screen, and the transparent input over it opens the native picker.
            Passed as a custom property, not `background`, so the chequerboard
            underneath survives. Only a value that already passed
            validThemeColor reaches here. */}
        <span
          className={`theme-color-swatch${previewed ? "" : " theme-color-swatch-unset"}`}
          style={previewed ? ({ "--swatch": previewed } as React.CSSProperties) : undefined}
        >
          <input
            type="color"
            className="theme-color-input"
            aria-label={`${ROLE_LABELS[role]}, ${SCHEME_LABELS[scheme]}`}
            value={exact ?? "#000000"}
            onChange={(event) => setThemeColor(role, scheme, event.target.value)}
          />
        </span>
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
        <button
          type="button"
          className="icon-btn icon-btn-quiet"
          aria-label={`Reset ${ROLE_LABELS[role]}, ${SCHEME_LABELS[scheme]} to default`}
          title="Reset to default"
          disabled={stored === ""}
          onClick={() => setThemeColor(role, scheme, "")}
        >
          ×
        </button>
      </div>
      {invalid && (
        <span className="helper-text danger-text">
          Not a colour value — the built-in colour is being used.
        </span>
      )}
      {adjusted && !invalid && (
        <span className="helper-text">
          Lightened or darkened to stay readable against what it sits on.
        </span>
      )}
    </div>
  );
}

export function ThemePage() {
  const { resetTheme, settingsRecord } = useSettings();
  const effective = {
    light: effectiveColorsFor(settingsRecord, "light"),
    dark: effectiveColorsFor(settingsRecord, "dark"),
  };

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
          Colours you set here follow you to your other devices and are kept in your
          backups. Clear a field, or press ×, to go back to the built-in colour. The
          dark column is used when your system asks for dark mode, so picking colours
          here does not stop the app following that.
        </p>
        <div className="section-stack">
          {THEME_COLOR_ROLES.map((role) => (
            <div className="field-group" key={role}>
              <span className="field-label">{ROLE_LABELS[role]}</span>
              <div className="layout-row">
                {THEME_SCHEMES.map((scheme) => (
                  <ColorField
                    role={role}
                    scheme={scheme}
                    effective={effective[scheme].colors[role]}
                    adjusted={effective[scheme].adjusted.has(role)}
                    key={scheme}
                  />
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
