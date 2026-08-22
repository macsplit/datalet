# Remote Sync Layer — Reproducible Debian Deployment

Status: reference deployment for the implemented `server/` sync tier. The
Docker Compose, Dockerfile, proxy, and systemd snippets below are templates;
the repository does not currently contain a ready-made `deploy/` directory,
so create those files from the snippets or adapt them to the target host.

Target: Debian 12 ("bookworm") or 13 ("trixie"), amd64/arm64. Two supported
paths are documented: **Docker Compose** (recommended — fewer moving parts
to get wrong, identical across machines) and a **native/systemd** path for
operators who'd rather not run Docker. Pick one; don't mix them.

## 1. Docker Compose (recommended)

> **There is now a working stack checked in at [`deploy/`](../deploy).**
> `cp deploy/.env.example deploy/.env`, set `NEO4J_PASSWORD`, then
> `./deploy/up.sh`. It builds, starts, and waits for `/sync/health` rather than
> reporting success the moment containers exist.
>
> That stack assumes TLS is terminated in front of it — an existing Cloudflare
> tunnel or reverse proxy pointing at `127.0.0.1:${SYNC_PORT}` — and caps
> Neo4j and Redis for a small always-on machine. The sections below remain the
> reference for everything it does not cover: the Caddy front (§1.2), the
> native/systemd path (§2), backups, and the configuration table (§3). Where
> the two disagree, the files in `deploy/` are what actually runs.

### 1.1 The stack itself

The layout, `docker-compose.yml`, `Dockerfile` and `.env.example` are checked
in under [`deploy/`](../deploy) and are what actually runs — see
[`deploy/README.md`](../deploy/README.md). They were transcribed snippets here
until they became real files; keeping a second, drifting copy in this document
would only invite someone to deploy the wrong one.

What the stack starts: `sync-server` (the built app *and* `/sync/*`, one
origin), `materializer` (same image, `ROLE=materializer`), `redis` (AOF on,
`noeviction`) and `neo4j`. Its memory limits are measured rather than
conventional, and the reasoning is in `deploy/README.md`.

The sections below cover what `deploy/` deliberately leaves out.


### 1.2 `Caddyfile`

```
{$SYNC_DOMAIN} {
	# SSE must not be buffered - keep `encode gzip` out of this block. A
	# compressing middleware withholds output until it has enough bytes to
	# emit a block, which silently stalls the stream; confirmed by testing
	# a real deployment (see build-history.md, step 2).
	@sync path /sync/stream
	handle @sync {
		reverse_proxy sync-server:3000 {
			flush_interval -1
		}
	}

	handle {
		encode gzip
		reverse_proxy sync-server:3000
	}
}
```

Caddy gets automatic HTTPS (Let's Encrypt) for free from a real domain in
`SYNC_DOMAIN`. For a LAN-only/no-public-DNS deployment, replace the site
block with `:443` + `tls internal` (Caddy's local CA) or `:80` plain HTTP
on a trusted network only — do not run the sync endpoint over plain HTTP on
an untrusted network, since patch payloads carry full record contents and
the `vaultToken` bearer secret (architecture doc §9).

### 1.3 `.env.example`

[`deploy/.env.example`](../deploy/.env.example) is the template to copy; §3
below is the full reference for every variable, including the ones it omits.
Add `SYNC_DOMAIN` when you are using the Caddy front above, which is the only
part of this that needs it.

Leave `ADMIN_TOKEN` empty on a single-tenant deployment: `/sync/admin/vaults`
answers `404` when it is unset, so an unused operator API is absent rather
than merely locked. On a multi-tenant one, set it to a long random value —
it reads every tenant's numbers, so treat it like a root credential and never
reuse a vault token for it.

Copy to `deploy/.env` and fill in real values. It is already ignored: the
repo's `.gitignore` carries a bare `.env` pattern, which git applies at any
depth, so no extra rule is needed.

### 1.4 Bring-up and backups

```bash
# first run
cd deploy
cp .env.example .env    # edit values
docker compose up -d
docker compose logs -f sync-server

# scale the stateless tier
docker compose up -d --scale sync-server=4

# Neo4j backup (dump while running, Community-edition-compatible approach:
# use neo4j-admin's online backup only if on Enterprise; on Community,
# schedule a stop-dump-start, or use `apoc.export` / periodic
# `neo4j-admin database dump` against a stopped instance for consistency)
docker compose exec neo4j neo4j-admin database dump neo4j --to-path=/backups
# → cron this nightly on the host, rotate /deploy/neo4j/backups externally
#   (e.g. rsync to another machine) — a backup that lives only on the same
#   disk as the primary isn't a backup.

# restore
docker compose stop neo4j
docker compose run --rm neo4j neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true
docker compose start neo4j
```

**Backups and erasure.** `DELETE /sync/vaults` removes a vault from Redis and
Neo4j immediately and completely, and the interface offers it as *Remove
permanently* on an archived datalet. It cannot reach a backup taken before the
deletion. If you are operating this for other people, that gap is yours to
close, not the application's: an erasure request is only satisfied once the
copies in your backup rotation have aged out or been purged. Decide the
retention window deliberately, and be able to state it — under the GDPR's right
to erasure the controller has to account for backup copies too, not only the
live store.

Redis's AOF file (`redis-data` volume) is a convenience cache of recent
patch history for fast catch-up, not a system of record — it's fine to lose
it (worst case, more nodes fall back to `/sync/snapshot` from Neo4j after a
Redis data loss). Don't bother backing it up; do make sure `appendonly yes`
is set so a plain container restart (not a volume loss) doesn't lose
already-acknowledged writes that hadn't reached Neo4j yet.

## 2. Native / systemd path (no Docker)

For operators who prefer apt-managed binaries directly on the Debian host.

### 2.1 Redis

```bash
sudo apt update
sudo apt install redis-server
sudo sed -i 's/^appendonly no/appendonly yes/' /etc/redis/redis.conf
sudo sed -i 's/^# maxmemory-policy .*/maxmemory-policy noeviction/' /etc/redis/redis.conf
sudo sed -i 's/^bind 127.0.0.1.*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf  # localhost only
sudo systemctl enable --now redis-server
```

### 2.2 Neo4j

Use Neo4j's own Debian apt repository (not Debian's bundled version, which
lags) for a reproducible, current install:

```bash
sudo apt install -y curl gnupg
curl -fsSL https://debian.neo4j.com/neotechnology.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/neo4j.gpg
echo "deb [signed-by=/usr/share/keyrings/neo4j.gpg] https://debian.neo4j.com stable 5" | sudo tee /etc/apt/sources.list.d/neo4j.list
sudo apt update
sudo apt install -y neo4j=1:5.* openjdk-17-jre-headless

sudo neo4j-admin dbms set-initial-password "$(openssl rand -base64 24)"
# save that generated password into your server's secrets store — this is
# the local-provisioning-secrets file pattern this repo already documents
# in `secrets.md`, extended to cover the new deployment's credentials.

sudo systemctl enable --now neo4j
```

Bind Neo4j to localhost only unless the sync-server runs on a different
host (`server.default_listen_address=127.0.0.1` in
`/etc/neo4j/neo4j.conf`), and tune memory for the box:

```
server.memory.heap.initial_size=512m
server.memory.heap.max_size=1G
server.memory.pagecache.size=512m
```

### 2.3 Node.js and the sync server

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable

sudo useradd --system --home /opt/localgraph --shell /usr/sbin/nologin syncsrv
sudo mkdir -p /opt/localgraph
sudo chown syncsrv:syncsrv /opt/localgraph
# deploy the built app (dist/ + server-dist/ + node_modules + package.json)
# to /opt/localgraph, e.g. via `rsync` from CI or a release tarball.
```

`/etc/systemd/system/localgraph-sync.service`:

```ini
[Unit]
Description=localgraph sync server
After=network.target redis-server.service neo4j.service
Wants=redis-server.service neo4j.service

[Service]
Type=simple
User=syncsrv
Group=syncsrv
WorkingDirectory=/opt/localgraph
EnvironmentFile=/opt/localgraph/.env
ExecStart=/usr/bin/node server-dist/index.js
Restart=on-failure
RestartSec=2
LimitNOFILE=65536

# hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/localgraph
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`LimitNOFILE=65536` matters here specifically because of long-lived SSE
connections (architecture doc §7) — the default 1024 fd limit will start
rejecting new sync streams well before the box is otherwise under load.

Run multiple instances on one host by templating the unit
(`localgraph-sync@.service`, `PORT=%i`) and pointing the reverse proxy at
each port, or just run one instance per host and scale by adding hosts
behind the proxy — either works given the stateless design.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now localgraph-sync
```

Run the materializer as a second unit using the same artifact and environment.
`/etc/systemd/system/localgraph-materializer.service`:

```ini
[Unit]
Description=localgraph Redis-to-Neo4j materializer
After=network.target redis-server.service neo4j.service
Wants=redis-server.service neo4j.service

[Service]
Type=simple
User=syncsrv
Group=syncsrv
WorkingDirectory=/opt/localgraph
EnvironmentFile=/opt/localgraph/.env
Environment=ROLE=materializer
ExecStart=/usr/bin/node server-dist/index.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/localgraph
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now localgraph-materializer
```

For multiple native workers, make the unit a template named
`localgraph-materializer@.service`, add these lines to `[Service]`, and put the
common count in `/opt/localgraph/.env`:

```ini
Environment=MATERIALIZER_SHARD_INDEX=%i
# /opt/localgraph/.env: MATERIALIZER_SHARD_COUNT=2
```

Then start every index exactly once:

```bash
sudo systemctl enable --now localgraph-materializer@0 localgraph-materializer@1
```

The same rule applies to Compose: define `materializer-0` and
`materializer-1` from the materializer service block, give both count `2`, and
give them indexes `0` and `1`. A duplicate index exits with an `already
claimed` error. A graceful stop releases its Redis lease immediately; after a
crash, allow the default 15-second lease to expire before replacement startup.

Changing the shard count reassigns vaults and changes which stable consumer
must recover them. Before an upgrade from the pre-sharding consumer
`materializer-1`, or before any shard-count change, stop ingest traffic, leave
the old materializers running until `XPENDING vault:<id>:stream materializer`
is zero for every vault, then stop the entire old pool and start the complete
new pool. Never roll a shard-count change one worker at a time.

### 2.4 Reverse proxy (nginx alternative to Caddy)

If not using Caddy, nginx needs explicit SSE-safe settings (Caddy does not
buffer by default, which is why it's the default recommendation — nginx
does, and it's easy to forget one of these three lines and silently break
streaming):

```nginx
location /sync/stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    add_header X-Accel-Buffering no;
}

location / {
    proxy_pass http://127.0.0.1:3000;
}
```

Use `certbot --nginx` for TLS if going this route.

### 2.5 Backups (native path)

```bash
# nightly cron, e.g. /etc/cron.d/localgraph-neo4j-backup
0 3 * * * neo4j neo4j-admin database dump neo4j --to-path=/var/backups/neo4j
```

Ship `/var/backups/neo4j` off-box on the same schedule (rsync/rclone to
remote storage) — a same-disk backup only survives Neo4j-level corruption,
not disk/host loss.

### 2.6 Optional legacy Neo4j label cleanup

New materialization uses only six shared metadata type labels plus
`Type_User`. Deployments that previously materialized user schemas may still
have harmless per-schema `Type_*` labels attached to records. Inspect them
without changing data:

```bash
# source/native checkout (loads .env.local when present)
pnpm cleanup:neo4j-labels

# built Docker image
docker compose run --rm materializer node server-dist/cleanupNeo4jLabels.js
```

The JSON output lists only stale, safely named labels that are still attached
to `:Record` nodes and the number of affected nodes. Review it, back up Neo4j,
then opt in to removal with `--apply` (append it to either command). The script
removes labels only; it does not change records or their exact indexed `type`
property. Neo4j may retain unused label tokens internally after removal, so a
raw `CALL db.labels()` can still show historical names even when no node carries
them; the cleanup command filters those inert tokens out.

## 3. Configuration reference

| Variable | Where | Purpose |
|---|---|---|
| `REDIS_URL` | sync-server, materializer | e.g. `redis://127.0.0.1:6379` |
| `NEO4J_URL` | sync-server, materializer | Bolt URL, e.g. `bolt://127.0.0.1:7687` |
| `NEO4J_USER` / `NEO4J_PASSWORD` | sync-server, materializer | Neo4j credentials |
| `PORT` | sync-server | HTTP port to listen on |
| `ROLE` | both | `materializer` runs the Redis-to-Neo4j consumer; anything else (or unset) runs the HTTP ingest tier and serves the app. One build, two deployables |
| `STATIC_DIR` | sync-server | directory of built client assets to serve (defaults to `../dist` relative to the compiled server) |
| `NEO4J_DATABASE` | sync-server, materializer | database name within the Neo4j instance (default `neo4j`) |
| `INSTANCE_ID` | sync-server | value reported in the `X-Instance-Id` response header; defaults to `pid-<pid>`. Set it per instance when running several behind one proxy, so a response can be traced to the process that served it |
| `VAULT_CREATE_RATE_LIMIT` / `VAULT_CREATE_RATE_WINDOW_SECONDS` | sync-server | `POST /sync/vaults` abuse limit (default 10 per hour per client IP — see architecture doc §9); trusts `X-Forwarded-For`, so only meaningful behind a reverse proxy that sets it truthfully |
| `PAIR_CODE_TTL_SECONDS` | sync-server | temporary pair-code lifetime (default 600 seconds) |
| `PAIR_REDEEM_RATE_LIMIT` / `PAIR_REDEEM_RATE_WINDOW_SECONDS` | sync-server | `POST /sync/pair-redeem` guessing limit (default 10 per minute per client IP; the same trusted-proxy requirement applies) |
| `VAULT_QUOTA_BYTES` | sync-server | maximum exact serialized bytes in one vault's Redis record store (default 8388608 / 8 MiB); lowering it below current usage blocks growth but still permits deletions |
| `VAULT_WRITE_RATE_LIMIT` / `VAULT_WRITE_RATE_WINDOW_SECONDS` | sync-server | authenticated patch-batch limit per vault (default 600 per 60 seconds); 429 responses remain queued and retry automatically in the browser |
| `MATERIALIZER_STREAMS_PER_CONNECTION` | materializer | maximum vault streams multiplexed into one blocking Redis read (default 64); lower it to reduce cross-vault head-of-line latency at the cost of more connections |
| `MATERIALIZER_SHARD_COUNT` / `MATERIALIZER_SHARD_INDEX` | materializer | common worker count and this process's zero-based index (defaults 1 and 0); every index must run exactly once |
| `MATERIALIZER_SHARD_LEASE_SECONDS` / `MATERIALIZER_SHARD_HEARTBEAT_MS` | materializer | duplicate-index lease TTL and refresh interval (defaults 15 seconds and 5000 ms; heartbeat must be shorter than TTL) |
| `TOMBSTONE_RETENTION_MS` / `TOMBSTONE_SWEEP_INTERVAL_MS` | materializer | how long a deleted record's tombstone is kept before purging, and how often the sweep runs (architecture doc §5) |
| `VAULT_IDLE_REPORT_AFTER_MS` | materializer | report-only inactivity threshold based on the last accepted write, or creation time for an empty vault (default 2592000000 / 30 days); never deletes data automatically |
| `ADMIN_TOKEN` | sync server | shared operator secret for `GET /sync/admin/vaults`; unset disables the route entirely (404). Never a vault token — it reads every tenant's numbers |

Vault tokens themselves need no server-side secret to configure: each is a
random opaque bearer value generated at vault-creation time, stored only
as a salted-in-practice-by-high-entropy SHA-256 hash per vault in Redis and
Neo4j (`vaultStore.ts`) — there's no server-wide signing key, so there's nothing
here to generate or rotate at the deployment level. A requested temporary
pair exchange holds that token in Redis only for its configured TTL so it can
hand the credential to the redeeming device. A leaked *vault*
token is rotated per-vault instead, via `POST /sync/vaults/rotate` (§9),
exposed in the app as the "Rotate token" button in Settings.

Follow the repo's existing convention (`secrets.md`) for documenting where
these values live locally without committing the values themselves.

## 4. Smoke test after standing up either path

```bash
curl -s https://sync.example.org/sync/health
# → {"ok":true}

curl -s -X POST https://sync.example.org/sync/vaults
# → {"vaultId":"...", "vaultToken":"..."}

STREAM_TICKET=$(curl -s -X POST \
  -H "Authorization: Bearer <token>" \
  "https://sync.example.org/sync/stream-ticket?vault=<id>" | jq -r .ticket)
curl -N \
  "https://sync.example.org/sync/stream?vault=<id>&since=0&ticket=${STREAM_TICKET}"
# → holds the connection open, ": ping" comments every ~20s (architecture
#   doc §7); confirms SSE isn't being buffered/killed by the proxy in front
```

If the `curl -N` stream doesn't show ping comments arriving continuously,
suspect proxy buffering first (§1.2 / §2.4) before suspecting the server.

The ticket can still appear in access logs, but it is stream-only and expires
after one hour. Configure the public proxy to redact query strings on
`/sync/stream` where possible; unlike the original design, the long-lived
vault bearer token never appears in that URL.
