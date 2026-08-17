// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createContext, createElement, useContext, useEffect, type ReactNode } from "react";
import { OrmSubscription } from "@ng-org/orm";
import { useShape } from "@ng-org/orm/react";
import { SettingsShapeType } from "../shapes/orm/settingsShapes.shapeTypes";
import usePrivateNuri from "../components/usePrivateNuri";
import { applyThemeToDocument } from "../utils/themeStylesheet";
import {
  THEME_COLOR_ROLES,
  THEME_SCHEMES,
  themeSettingsField,
  type ThemeColorRole,
  type ThemeScheme,
} from "../utils/themeTokens";

type SettingsValue = {
  format: (amount: number) => string;
  symbol: string;
  appTitle: string;
  setAppTitle: (next: string) => void;
  /** The raw Settings record, for callers that need the whole stored theme. */
  settingsRecord: Record<string, unknown>;
  themeColor: (role: ThemeColorRole, scheme: ThemeScheme) => string;
  setThemeColor: (role: ThemeColorRole, scheme: ThemeScheme, next: string) => void;
  resetTheme: () => void;
};

const SettingsContext = createContext<SettingsValue | undefined>(undefined);

const DEFAULT_APP_TITLE = "Local Knowledge Graph";
export const SETTINGS_ID = "did:ng:z:SettingsSingleton";

/** Currency widgets retain their established EUR display without a global preference. */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
    // Keep the compact symbol used by the field label and prior display.
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Reads and writes the app's single Settings object. There is exactly one
 * per private store, created lazily the first
 * time any component uses this hook. Stored and synced the same way as
 * every other piece of app data - through the ORM, not a separate ad hoc
 * mechanism - so it persists and propagates across tabs like everything
 * else.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const privateNuri = usePrivateNuri();
  const settingsSet = useShape(SettingsShapeType, privateNuri);

  useEffect(() => {
    if (!privateNuri) return;
    let cancelled = false;
    // useShape owns this same canonical subscription. Acquiring a reference
    // here exposes its readiness promise, avoiding a race between an arbitrary
    // frame delay and the engine's initial-data callback on reload.
    const subscription = OrmSubscription.getOrCreate(SettingsShapeType, {
      graphs: [privateNuri],
    });
    void subscription.readyPromise.then(() => {
      if (!cancelled && settingsSet.size === 0) {
        settingsSet.add({
          "@graph": privateNuri,
          // A fixed identity makes concurrent bootstrap attempts from two
          // tabs converge on one record instead of minting duplicates.
          "@id": SETTINGS_ID,
          "@type": "did:ng:z:Settings",
          appTitle: DEFAULT_APP_TITLE,
        });
      }
    });
    return () => {
      cancelled = true;
      subscription.close();
    };
  }, [privateNuri, settingsSet]);

  const settings = settingsSet.first?.();
  const appTitle: string = settings?.appTitle || DEFAULT_APP_TITLE;

  const setAppTitle = (next: string) => {
    if (settings) settings.appTitle = next;
  };

  const themeColor = (role: ThemeColorRole, scheme: ThemeScheme): string => {
    const stored = settings?.[themeSettingsField(role, scheme) as keyof typeof settings];
    return typeof stored === "string" ? stored : "";
  };

  const setThemeColor = (role: ThemeColorRole, scheme: ThemeScheme, next: string) => {
    if (!settings) return;
    const field = themeSettingsField(role, scheme) as keyof typeof settings;
    // Clearing a field is how a role returns to the stylesheet default, so an
    // empty input removes the property rather than storing an empty string
    // that would fail validation on every later read.
    if (next.trim() === "") delete settings[field];
    else (settings as Record<string, unknown>)[field] = next.trim();
  };

  const resetTheme = () => {
    if (!settings) return;
    for (const role of THEME_COLOR_ROLES) {
      for (const scheme of THEME_SCHEMES) {
        delete settings[themeSettingsField(role, scheme) as keyof typeof settings];
      }
    }
  };

  // Re-applied on every render rather than in an effect keyed on the record:
  // ORM signal objects mutate in place, so a dependency array cannot see a
  // colour change. applyThemeToDocument is a no-op when the CSS is unchanged.
  applyThemeToDocument((settings ?? {}) as Record<string, unknown>);

  const value: SettingsValue = {
    format: formatCurrency,
    symbol: "€",
    appTitle,
    setAppTitle,
    settingsRecord: (settings ?? {}) as Record<string, unknown>,
    themeColor,
    setThemeColor,
    resetTheme,
  };

  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings() {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings must be used inside SettingsProvider.");
  return value;
}
