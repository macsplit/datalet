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
import { DataletSettings } from "../components/DataletSettings";
import { CloneCodes } from "../components/CloneCodes";
import { StorageUsage } from "../components/StorageUsage";
import { DataBackup } from "../components/DataBackup";
import { SyncSettings } from "../components/SyncSettings";

/**
 * Where a datalet lives and who else has it, as opposed to what it is made of.
 *
 * These five panels were the bulk of Settings, which left the page reading as
 * nine unrelated things. They belong together for a reason that outlives the
 * tidying: each one is about the datalet as a movable object rather than a
 * preference. Storage is here because the percent bar is what refuses a
 * switch (see `adoptionFits`), so it belongs beside switching rather than
 * among display settings; backup is here because export and import are the
 * third way records move between places, alongside pairing and copy codes.
 *
 * Order matters. Switching comes first because it is the only thing here
 * anyone does more than once or twice, and pairing comes last because it is
 * done once per device and then forgotten.
 */
export function DataletsPage() {
  return (
    <div className="page-content">
      <header className="page-hero">
        <h1>Datalets and devices</h1>
        <p>
          Switch between datalets, give someone a copy, sync to your other devices, and
          export backups.
        </p>
      </header>
      <DataletSettings />
      <CloneCodes />
      <StorageUsage />
      <DataBackup />
      <SyncSettings />
      <Link className="secondary-btn button-link" to="/settings">
        ← Back to Settings
      </Link>
    </div>
  );
}
