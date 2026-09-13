// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { Link } from "@tanstack/react-router";

export function AboutPage() {
  return (
    <div className="page-content about-page">
      <header className="page-hero">
        <h1>About</h1>
        <p>A small, open-source home for structured information.</p>
      </header>

      <section className="panel">
        <div>
          <p className="label-accent">What this is</p>
          <h2 className="title">A record-keeping app you build yourself</h2>
        </div>
        <p className="description">
          A datalet is one such app together with everything in it: its records, and
          the schemas, navigation tabs, layouts, blocks and field widgets that decide
          how they are shown. You define all of it through the Settings UI, can keep
          as many datalets as you like, and use one at a time.
        </p>
        <p className="description">
          It needs no account, wallet, API key, or server to store and use data in
          this browser. An optional sync server can pair a private copy across
          devices; leaving sync unconfigured keeps everything entirely local.
        </p>
      </section>

      <section className="panel">
        <div>
          <p className="label-accent">How this is built</p>
          <h2 className="title">The app definition is data too</h2>
        </div>
        <p className="description">
          The schema, the screen and the records are all stored the same way, as part
          of the same datalet. A tab you build syncs like any record, because it is one; a
          backup holds the app and its contents in one file.
        </p>
      </section>

      <section className="panel">
        <div>
          <p className="label-accent">Datalet</p>
          <h2 className="title">Open source</h2>
        </div>
        <p className="description">
          Datalet is open-source software. You can inspect the code, report an issue,
          or build your own version in the{" "}
          <a href="https://github.com/macsplit/datalet" target="_blank" rel="noreferrer">
            source code repository
          </a>.
        </p>
      </section>

      <section className="panel">
        <div>
          <p className="label-accent">Privacy</p>
          <h2 className="title">Where your information goes</h2>
        </div>
        <p className="description">
          Datalet has no accounts, ads, or analytics. Your records and settings stay in
          this browser unless you choose to use remote sync or make a copy. Synced
          datalets are not end-to-end encrypted: their contents can be read by the sync
          server operator. Like any website, its host may also receive ordinary
          connection information such as your IP address.
        </p>
      </section>

      <section className="panel">
        <div>
          <p className="label-accent">Browser storage</p>
          <h2 className="title">No cookies</h2>
        </div>
        <p className="description">
          Datalet does not set cookies. It uses local storage to keep your records,
          settings, and any sync credentials on this device; session storage remembers
          a dismissed storage notice until the tab closes; and an offline cache keeps
          the app itself available without a connection.
        </p>
        <p className="description">
          Clearing this site&apos;s browser data removes the local copy and its sync
          credentials, but does not erase data already held by a sync server, exported
          backups, or copies made elsewhere. You can export or remove a datalet under{" "}
          <Link to="/settings/datalets">Manage datalets</Link>.
        </p>
      </section>

      <Link className="secondary-btn button-link" to="/settings">
        ← Back to Settings
      </Link>
    </div>
  );
}
