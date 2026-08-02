// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { useSettings, type Currency } from "../hooks/useSettings";

const CURRENCY_OPTIONS: { value: Currency; label: string }[] = [
  { value: "did:ng:z:USD", label: "US Dollar ($)" },
  { value: "did:ng:z:GBP", label: "British Pound (£)" },
  { value: "did:ng:z:EUR", label: "Euro (€)" },
];

export function SettingsPage() {
  const { currency, setCurrency, appTitle, setAppTitle } = useSettings();

  return (
    <div className="page-content">
      <header className="page-hero">
        <h1>Settings</h1>
        <p>Preferences for how this app displays your data.</p>
      </header>
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="label-accent">Display</p>
            <h2 className="title">App title</h2>
          </div>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="app-title-input">
            Shown in the nav bar and browser tab
          </label>
          <input
            id="app-title-input"
            className="input"
            value={appTitle}
            onChange={(e) => setAppTitle(e.target.value)}
          />
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="label-accent">Display</p>
            <h2 className="title">Currency</h2>
          </div>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="currency-select">
            Currency used for amounts
          </label>
          <select
            id="currency-select"
            className="select"
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
          >
            {CURRENCY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <p className="helper-text">
          Changing currency only changes how amounts are displayed - existing values
          are not converted.
        </p>
      </section>
    </div>
  );
}
