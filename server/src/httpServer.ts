// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  applyBatch,
  checkVaultToken,
  createVault,
  entriesSince,
  snapshot,
  subscribeLive,
  vaultExists,
  type LogEntry,
} from "./vaultStore.js";
import { serveStatic } from "./staticServer.js";
import type { Patch } from "./patchApply.js";

const MAX_BODY_BYTES = 2_000_000;
const HEARTBEAT_MS = 20_000;

// Purely diagnostic: identifies which stateless instance served a given
// request, so horizontal-scaling behavior (any instance can serve any
// vault) can be observed/verified from outside instead of taken on faith.
const INSTANCE_ID = process.env.INSTANCE_ID ?? `pid-${process.pid}`;

function setCors(res: ServerResponse, req: IncomingMessage) {
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("X-Instance-Id", INSTANCE_ID);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw.length ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

export function createSyncServer(staticDir: string) {
  return createServer(async (req, res) => {
    setCors(res, req);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (url.pathname === "/sync/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/sync/vaults" && req.method === "POST") {
        sendJson(res, 200, await createVault());
        return;
      }

      if (url.pathname === "/sync/patches" && req.method === "POST") {
        const vaultId = url.searchParams.get("vault") ?? "";
        if (!(await vaultExists(vaultId))) {
          sendJson(res, 404, { accepted: false, reason: "unknown vault" });
          return;
        }
        const token = bearerToken(req);
        if (!token || !(await checkVaultToken(vaultId, token))) {
          sendJson(res, 401, { accepted: false, reason: "invalid token" });
          return;
        }

        const body = (await readJsonBody(req)) as {
          nodeId?: string;
          batchId?: string;
          hlc?: string;
          shape?: string;
          patches?: unknown;
        };
        if (
          !body.nodeId ||
          !body.batchId ||
          !body.hlc ||
          !body.shape ||
          !Array.isArray(body.patches)
        ) {
          sendJson(res, 400, { accepted: false, reason: "malformed request" });
          return;
        }

        const result = await applyBatch(vaultId, {
          nodeId: body.nodeId,
          batchId: body.batchId,
          hlc: body.hlc,
          shape: body.shape,
          patches: body.patches as Patch[],
        });
        sendJson(res, result.accepted ? 200 : 409, result);
        return;
      }

      if (url.pathname === "/sync/snapshot" && req.method === "GET") {
        const vaultId = url.searchParams.get("vault") ?? "";
        if (!(await vaultExists(vaultId))) {
          sendJson(res, 404, { reason: "unknown vault" });
          return;
        }
        const token = bearerToken(req);
        if (!token || !(await checkVaultToken(vaultId, token))) {
          sendJson(res, 401, { reason: "invalid token" });
          return;
        }
        sendJson(res, 200, await snapshot(vaultId));
        return;
      }

      if (url.pathname === "/sync/stream" && req.method === "GET") {
        const vaultId = url.searchParams.get("vault") ?? "";
        if (!(await vaultExists(vaultId))) {
          sendJson(res, 404, { reason: "unknown vault" });
          return;
        }
        // Browsers' EventSource cannot set an Authorization header, so this
        // one endpoint also accepts the bearer token as a query parameter.
        const token = url.searchParams.get("token") ?? bearerToken(req);
        if (!token || !(await checkVaultToken(vaultId, token))) {
          sendJson(res, 401, { reason: "invalid token" });
          return;
        }

        const sinceParam = url.searchParams.get("since") ?? req.headers["last-event-id"];
        const since = Number(sinceParam ?? 0);
        const startSeq = Number.isFinite(since) ? since : 0;

        const initialEntries = await entriesSince(vaultId, startSeq);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        // writeHead() alone doesn't push bytes onto the socket - Node holds
        // headers until the first write(). A vault with no history yet (or
        // simply no new activity for a while) would otherwise leave the
        // client's connection looking dead until either the first patch or
        // the 20s heartbeat arrives.
        res.flushHeaders();

        if (initialEntries === undefined) {
          res.write(`event: resync\ndata: ${JSON.stringify({ reason: "gap exceeds retained log" })}\n\n`);
          res.end();
          return;
        }

        const sent = new Set<number>();
        const writeEntry = (entry: LogEntry) => {
          if (sent.has(entry.seq)) return;
          sent.add(entry.seq);
          res.write(`id: ${entry.seq}\nevent: patches\ndata: ${JSON.stringify(entry)}\n\n`);
        };

        // Attach the live watcher BEFORE finishing historical replay, so
        // nothing committed during the replay window can be missed - any
        // resulting duplicate delivery is harmless (client dedupes by
        // batchId). See vaultStore.ts's subscribeLive doc comment.
        const unsubscribe = subscribeLive(vaultId, writeEntry);

        for (const entry of initialEntries) writeEntry(entry);
        const lastSentSeq =
          initialEntries.length > 0 ? initialEntries[initialEntries.length - 1].seq : startSeq;
        const gapCloser = await entriesSince(vaultId, lastSentSeq);
        if (gapCloser) for (const entry of gapCloser) writeEntry(entry);

        const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        serveStatic(staticDir, req, res);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : "internal error" });
    }
  });
}
