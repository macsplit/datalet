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
import type { Settings } from "../shapes/orm/settingsShapes.typings";
import usePrivateNuri from "../components/usePrivateNuri";

export type Currency = Settings["currency"];

type SettingsValue = {
  currency: Currency;
  setCurrency: (next: Currency) => void;
  format: (amount: number) => string;
  symbol: string;
  appTitle: string;
  setAppTitle: (next: string) => void;
};

const SettingsContext = createContext<SettingsValue | undefined>(undefined);

const DEFAULT_CURRENCY: Currency = "did:ng:z:EUR";
const DEFAULT_APP_TITLE = "Local Knowledge Graph";
export const SETTINGS_ID = "did:ng:z:SettingsSingleton";

const CURRENCY_CODES: Record<Currency, string> = {
  "did:ng:z:USD": "USD",
  "did:ng:z:GBP": "GBP",
  "did:ng:z:EUR": "EUR",
};

const CURRENCY_SYMBOLS: Record<Currency, string> = {
  "did:ng:z:USD": "$",
  "did:ng:z:GBP": "£",
  "did:ng:z:EUR": "€",
};

/** Formats an amount as currency, in the browser's own locale. */
export function formatCurrency(amount: number, currency: Currency): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: CURRENCY_CODES[currency],
    // Without this, some locales render USD as "US$" instead of "$" to
    // disambiguate from other dollar currencies (AUD, CAD, ...). We only
    // support one currency at a time, so that disambiguation adds nothing -
    // narrowSymbol is Intl.NumberFormat's own option for "just the short
    // symbol", not a workaround.
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
  }).format(amount);
}

/** The currency's symbol, for compact labels like "Total price ($)". */
export function currencySymbol(currency: Currency): string {
  return CURRENCY_SYMBOLS[currency];
}

/**
 * Reads and writes the app's single Settings object. There is exactly one
 * per private store, created lazily (with the default currency) the first
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
          currency: DEFAULT_CURRENCY,
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
  const currency: Currency = settings?.currency ?? DEFAULT_CURRENCY;
  const appTitle: string = settings?.appTitle || DEFAULT_APP_TITLE;

  const setCurrency = (next: Currency) => {
    if (settings) settings.currency = next;
  };

  const setAppTitle = (next: string) => {
    if (settings) settings.appTitle = next;
  };

  const value: SettingsValue = {
    currency,
    setCurrency,
    format: (amount: number) => formatCurrency(amount, currency),
    symbol: currencySymbol(currency),
    appTitle,
    setAppTitle,
  };

  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings() {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings must be used inside SettingsProvider.");
  return value;
}
