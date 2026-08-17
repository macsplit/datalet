// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { useSettings } from "../hooks/useSettings";
import {
  THEME_COLOR_ROLES,
  THEME_SCHEMES,
  validThemeColor,
  type ThemeColorRole,
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

export function ThemeSettings() {
  const { themeColor, setThemeColor, resetTheme } = useSettings();

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="label-accent">Display</p>
          <h2 className="title">Theme</h2>
        </div>
        <button type="button" className="secondary-btn" onClick={resetTheme}>
          Reset theme
        </button>
      </div>
      <p className="helper-text">
        Colours are stored in the graph like your records, so a theme set here reaches
        your other devices and is included in a backup. Leave a field empty to keep the
        built-in colour. The dark column applies when your system asks for dark mode.
      </p>
      <div className="section-stack">
        {THEME_COLOR_ROLES.map((role) => (
          <div className="layout-row" key={role}>
            <span className="field-label">{ROLE_LABELS[role]}</span>
            {THEME_SCHEMES.map((scheme) => {
              const value = themeColor(role, scheme);
              // An unparseable stored value is flagged here rather than
              // silently ignored: the stylesheet already drops it, so without
              // this the field would look set while nothing changed on screen.
              const invalid = value !== "" && validThemeColor(value) === undefined;
              const inputId = `theme-${role}-${scheme}`;
              return (
                <span className="field-group" key={scheme}>
                  <label className="field-label" htmlFor={inputId}>
                    {scheme === "dark" ? "Dark" : "Light"}
                  </label>
                  <input
                    id={inputId}
                    className="input"
                    value={value}
                    placeholder="default"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    aria-invalid={invalid || undefined}
                    onChange={(event) => setThemeColor(role, scheme, event.target.value)}
                  />
                  {invalid && (
                    <span className="helper-text danger-text">
                      Not a colour value — the built-in colour is being used.
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
