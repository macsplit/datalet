// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { useEffect, useState } from "react";
import { session, sessionPromise, type LocalSession } from "../utils/ngSession";
import { getVaultConfig } from "../utils/remoteSyncEngine";

/**
 * When a sync vault is paired (Settings > Remote sync), the app's active
 * graph becomes the vault's id instead of this device's random private
 * store id, so records land in the graph the sync server and every other
 * paired device share. Pairing/unpairing reloads the page (see
 * SyncSettings.tsx), so this only needs to resolve once per app load, not
 * react to vault config changes mid-session.
 */
function activeGraph(currentSession: LocalSession | undefined): string | undefined {
  const vault = getVaultConfig();
  if (vault) return `did:ng:${vault.vaultId}`;
  return currentSession && `did:ng:${currentSession.private_store_id}`;
}

/** Return the NURI of the store this device's data currently lives in. */
const usePrivateNuri = () => {
  const [privateNuri, setPrivateNuri] = useState(activeGraph(session));

  useEffect(() => {
    let active = true;
    if (!session) {
      void sessionPromise.then((resolvedSession) => {
        if (active) setPrivateNuri(activeGraph(resolvedSession));
      });
    }
    return () => {
      active = false;
    };
  }, []);

  return privateNuri;
};

export default usePrivateNuri;
