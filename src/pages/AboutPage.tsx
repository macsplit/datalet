// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import "./AboutPage.css";

export function AboutPage() {
  return (
    <div className="page-content">
      <header className="page-hero">
        <h1>About this app</h1>
        <p>A small, local-first expense tracker built on NextGraph's RDF/Graph ORM.</p>
      </header>
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="label-accent">Architecture</p>
            <h2 className="title">How data is stored</h2>
          </div>
        </div>
        <ul className="about-fact-list">
          <li>
            <strong>No wallet, no account.</strong> A local session is generated once and
            kept in this browser.
          </li>
          <li>
            <strong>No network connection.</strong> Data is persisted to{" "}
            <code>localStorage</code> only.
          </li>
          <li>
            <strong>Synced across tabs.</strong> Changes broadcast live to other tabs of
            this browser via <code>BroadcastChannel</code>.
          </li>
        </ul>
      </section>
    </div>
  );
}
