# deploy/

A working Docker Compose stack for the sync tier, sized for a small always-on
machine. [`../docs/remote-sync-deployment.md`](../docs/remote-sync-deployment.md)
is the reference — options, the native/systemd alternative, backups, the
configuration table and the post-deploy smoke test. This directory is the
short path.

```sh
cp .env.example .env      # then set NEO4J_PASSWORD
./up.sh
```

`up.sh` is safe to re-run: it rebuilds, restarts what changed, leaves the
volumes alone, and waits for `/sync/health` rather than reporting success the
moment containers exist.

## What it starts

| Service | Why |
| --- | --- |
| `sync-server` | Serves the built app *and* `/sync/*`. One origin, which is what the CSP's `connect-src 'self'` requires. |
| `materializer` | Same image, `ROLE=materializer`. Replays accepted writes into Neo4j. |
| `redis` | Ingest, sequencing and fanout. AOF on, `noeviction`. |
| `neo4j` | The durable system of record, and what `/sync/snapshot` reads. |

## TLS

Not terminated here. Point an existing Cloudflare tunnel or reverse proxy at
`127.0.0.1:${SYNC_PORT}`; the port is bound to loopback precisely so nothing
reaches an origin that terminates no TLS of its own. For a self-contained
Caddy front instead, see the deployment doc §1.4.

## The limits are deliberate

Neo4j's stock heap alone would claim more memory than a small box has spare,
for a durable copy measured in megabytes per vault. It is capped to 512 MB heap
and 256 MB page cache, with a container limit above that. Redis is capped and
set to `noeviction`, because it is a system of record: a full Redis must refuse
writes, never silently drop them.

## Measured footprint

The whole stack, idle, on a Celeron N4505 NUC with 7.5 GB RAM:

| | Resident | Limit |
| --- | --- | --- |
| `neo4j` | 833 MiB | 1500 M |
| `sync-server` | 34 MiB | 512 M |
| `materializer` | 28 MiB | 384 M |
| `redis` | 15 MiB | — |

About 910 MB in total, and host memory pressure stayed at zero. Neo4j is
essentially the entire cost; the two Node processes are rounding errors beside
it. The image is 427 MB.

Raise these when the numbers say to. `GET /sync/admin/vaults` reports per-vault
size and materialization lag once `ADMIN_TOKEN` is set, and lag is the earliest
honest signal that one materializer is no longer enough.

## Scaling past one box

Nothing here is single-machine by design. `sync-server` holds no state, so it
scales by running more of it behind the same proxy. The materializer scales by
shard: run N processes with `MATERIALIZER_SHARD_COUNT=N` and a distinct
`MATERIALIZER_SHARD_INDEX` each, and a Redis lease stops two claiming one
shard. Redis and Neo4j are then the parts to move off the box first. Changing
the shard count is not a rolling operation — stop the materializers, change it,
start them.
