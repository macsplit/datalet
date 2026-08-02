// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { useEffect } from "react";
import { useShape } from "@ng-org/orm/react";
import { getObjects } from "@ng-org/orm";
import { SettingsShapeType } from "../shapes/orm/settingsShapes.shapeTypes";
import type { Settings } from "../shapes/orm/settingsShapes.typings";
import usePrivateNuri from "../components/usePrivateNuri";

export type Currency = Settings["currency"];

const DEFAULT_CURRENCY: Currency = "did:ng:z:EUR";
const DEFAULT_APP_TITLE = "Local Knowledge Graph";

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
 * Ensures a default Settings object exists in the private store. Guarded by
 * a module-level promise (rather than a per-component ref) so that multiple
 * components mounting `useSettings()` at once - e.g. a page full of
 * ExpenseCards - can't race and each insert their own default, leaving
 * duplicate Settings objects behind.
 *
 * Deliberately adds to the live `settingsSet` from `useShape` (the same
 * mechanism "add expense"/"add category" already use) rather than the
 * `insertObject` utility. `insertObject` runs the add on its own disposable,
 * unscoped connection - fine for a document nobody else is watching, but
 * here another already-mounted `useShape(SettingsShapeType, ...)` is
 * watching the same shape+scope, and relaying that connection's raw patches
 * over to it confuses the receiving side's object-identity bookkeeping
 * ("you must specify the @graph"). Adding straight to the shared live Set
 * sidesteps that entirely.
 */
let ensureDefaultSettings: Promise<void> | undefined;

function ensureDefaultSettingsOnce(
  privateNuri: string,
  settingsSet: { size: number; add: (obj: unknown) => void },
): Promise<void> {
  if (!ensureDefaultSettings) {
    ensureDefaultSettings = (async () => {
      const existing = await getObjects(SettingsShapeType, privateNuri);
      if (existing.size === 0) {
        settingsSet.add({
          "@graph": privateNuri,
          "@id": "",
          "@type": "did:ng:z:Settings",
          currency: DEFAULT_CURRENCY,
          appTitle: DEFAULT_APP_TITLE,
        });
      }
    })();
  }
  return ensureDefaultSettings;
}

/**
 * Reads and writes the app's single Settings object. There is exactly one
 * per private store, created lazily (with the default currency) the first
 * time any component uses this hook. Stored and synced the same way as
 * every other piece of app data - through the ORM, not a separate ad hoc
 * mechanism - so it persists and propagates across tabs like everything
 * else.
 */
export function useSettings() {
  const privateNuri = usePrivateNuri();
  const settingsSet = useShape(SettingsShapeType, privateNuri);

  useEffect(() => {
    if (privateNuri) ensureDefaultSettingsOnce(privateNuri, settingsSet);
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

  return {
    currency,
    setCurrency,
    format: (amount: number) => formatCurrency(amount, currency),
    symbol: currencySymbol(currency),
    appTitle,
    setAppTitle,
  };
}
