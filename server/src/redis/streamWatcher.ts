// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { newBlockingConnection } from "./client.js";
import type { LogEntry } from "../vaultStore.js";

type Listener = (entry: LogEntry) => void;

const BLOCK_MS = 5_000;

/**
 * Tails one vault's Redis Stream on a dedicated blocking connection and fans
 * new entries out to every locally-attached SSE listener on this process -
 * this is what lets any sync-server instance serve any vault's live stream
 * regardless of which instance accepted the write (see
 * remote-sync-architecture.md §6.1-6.2). One watcher per actively-streamed
 * vault per process, created on first listener and torn down on last.
 */
class VaultStreamWatcher {
  private readonly connection = newBlockingConnection();
  private lastId: string;
  private readonly listeners = new Set<Listener>();
  private running = true;

  constructor(
    private readonly streamKey: string,
    private readonly onIdle: () => void,
  ) {
    // Listeners always do their own historical XRANGE catch-up before (and,
    // to close the handoff race, immediately after) attaching here, so this
    // only needs to start tailing "from now" - see entriesSince() callers
    // in httpServer.ts. Duplicate delivery across that handoff is harmless:
    // the client dedupes by batchId.
    this.lastId = "$";
    void this.loop();
  }

  addListener(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private async loop() {
    while (this.running) {
      let result: [string, [string, string[]][]][] | null;
      try {
        result = await this.connection.xread("BLOCK", BLOCK_MS, "STREAMS", this.streamKey, this.lastId);
      } catch {
        if (!this.running) return;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      if (!result) continue; // BLOCK timed out with nothing new - loop and re-check `running`

      for (const [, entries] of result) {
        for (const [id, fields] of entries) {
          this.lastId = id;
          const dataIndex = fields.indexOf("data");
          if (dataIndex === -1) continue;
          try {
            const entry = JSON.parse(fields[dataIndex + 1]) as LogEntry;
            for (const listener of this.listeners) listener(entry);
          } catch {
            // Malformed stream entry - skip rather than kill the watcher.
          }
        }
      }
    }
  }

  private stop() {
    this.running = false;
    this.connection.disconnect();
    this.onIdle();
  }
}

const watchers = new Map<string, VaultStreamWatcher>();

/** Attach `listener` to a vault's live stream, starting a watcher for it if none exists yet. */
export function watchVaultStream(streamKey: string, listener: Listener): () => void {
  let watcher = watchers.get(streamKey);
  if (!watcher) {
    watcher = new VaultStreamWatcher(streamKey, () => watchers.delete(streamKey));
    watchers.set(streamKey, watcher);
  }
  return watcher.addListener(listener);
}
