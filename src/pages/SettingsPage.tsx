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
import { Link } from "@tanstack/react-router";
import { SyncSettings } from "../components/SyncSettings";
import { DataBackup } from "../components/DataBackup";

export function SettingsPage() {
  const { appTitle, setAppTitle } = useSettings();

  return (
    <div className="page-content">
      <header className="page-hero">
        <h1>Settings</h1>
        <p>Preferences for how this app displays your data.</p>
      </header>
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="label-accent">Builder</p>
            <h2 className="title">Data schemas</h2>
          </div>
          <Link className="primary-btn button-link" to="/settings/schemas">
            Manage schemas
          </Link>
        </div>
        <p className="helper-text">
          Define reusable record types and the fields stored on each one.
        </p>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="label-accent">Builder</p>
            <h2 className="title">Navigation tabs</h2>
          </div>
          <Link className="primary-btn button-link" to="/settings/tabs">
            Manage tabs
          </Link>
        </div>
        <p className="helper-text">
          Create, rename, and arrange the pages shown in the app navigation.
        </p>
      </section>
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
      <DataBackup />
      <SyncSettings />
    </div>
  );
}
