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

export function SettingsPage() {
  const { appTitle, setAppTitle } = useSettings();

  return (
    <div className="page-content">
      <header className="page-hero">
        <h1>Settings</h1>
        <p>How this app is built, how it looks, and where your data lives.</p>
      </header>
      <section className="panel" id="datalets">
        <div className="panel-header">
          <div>
            <p className="label-accent">Datalets</p>
            <h2 className="title">Your datalets</h2>
          </div>
          <Link className="primary-btn button-link" to="/settings/datalets">
            Manage datalets
          </Link>
        </div>
        <p className="helper-text">
          Switch between datalets, give someone a copy, sync to your other devices, and
          export backups.
        </p>
      </section>
      <section className="panel" id="schemas">
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
      <section className="panel" id="tabs">
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
      <section className="panel" id="theme">
        <div className="panel-header">
          <div>
            <p className="label-accent">Display</p>
            <h2 className="title">Theme</h2>
          </div>
          <Link className="primary-btn button-link" to="/settings/theme">
            Choose colours
          </Link>
        </div>
        <p className="helper-text">
          Set the app's colours for light and dark mode. They follow you to your other
          devices and are kept in your backups.
        </p>
      </section>
      <section className="panel" id="app-title">
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
      <footer className="settings-footer">
        <Link to="/settings/about">About Datalet, privacy, and browser storage</Link>
      </footer>
    </div>
  );
}
