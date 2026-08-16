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

### 1.1 Layout

```
deploy/
├── docker-compose.yml
├── .env.example
├── Dockerfile.sync-server
├── Caddyfile
└── neo4j/
    └── backup.sh
```

### 1.2 `docker-compose.yml`

```yaml
name: localgraph-sync

services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: >
      redis-server
      --appendonly yes
      --appendfsync everysec
      --maxmemory-policy noeviction
    volumes:
      - redis-data:/data
    networks: [backend]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  neo4j:
    image: neo4j:5-community
    restart: unless-stopped
    environment:
      NEO4J_AUTH: "neo4j/${NEO4J_PASSWORD}"
      NEO4J_server_memory_heap_initial__size: "512m"
      NEO4J_server_memory_heap_max__size: "1G"
      NEO4J_server_memory_pagecache_size: "512m"
      # Bolt only needs to be reachable from the sync-server containers.
    volumes:
      - neo4j-data:/data
      - neo4j-logs:/logs
      - ./neo4j/backups:/backups
    networks: [backend]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:7474"]
      interval: 10s
      timeout: 5s
      retries: 10

  sync-server:
    build:
      context: ..
      dockerfile: deploy/Dockerfile.sync-server
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
      neo4j:
        condition: service_healthy
    environment:
      REDIS_URL: "redis://redis:6379"
      NEO4J_URL: "bolt://neo4j:7687"
      NEO4J_USER: "neo4j"
      NEO4J_PASSWORD: "${NEO4J_PASSWORD}"
      PORT: "3000"
      NODE_ENV: "production"
    networks: [backend]
    deploy:
      replicas: 2   # stateless — scale this number freely
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/sync/health"]
      interval: 10s
      timeout: 3s
      retries: 5

  materializer:
    build:
      context: ..
      dockerfile: deploy/Dockerfile.sync-server
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
      neo4j:
        condition: service_healthy
    environment:
      ROLE: "materializer"
      REDIS_URL: "redis://redis:6379"
      NEO4J_URL: "bolt://neo4j:7687"
      NEO4J_USER: "neo4j"
      NEO4J_PASSWORD: "${NEO4J_PASSWORD}"
      NODE_ENV: "production"
    networks: [backend]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on: [sync-server]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    networks: [backend]

networks:
  backend:

volumes:
  redis-data:
  neo4j-data:
  neo4j-logs:
  caddy-data:
  caddy-config:
```

Notes:

- Only `caddy` publishes host ports. Redis and Neo4j are reachable only on
  the internal `backend` network — never expose 6379/7474/7687 to the host
  or internet directly.
- `sync-server` has no published port either; Caddy proxies to it by
  service name, and with `replicas: 2` Compose's built-in DNS round-robins
  across instances — this is the "any instance can serve any vault" design
  from the architecture doc paying off operationally (no sticky sessions to
  configure).
- `materializer` runs the same image with `ROLE=materializer`. Keep at least
  one instance running: it consumes accepted Redis Stream entries into Neo4j,
  which is what makes snapshots and durable recovery advance.
- Neo4j Community, single instance: no built-in HA/clustering. That's an
  accepted trade for a reproducible single-server OSS setup (see
  architecture doc §6.4/§7); back it up on a schedule (§1.6 below) and if
  you outgrow single-instance Neo4j, that's the point to evaluate Neo4j
  Enterprise causal clustering or a managed Neo4j offering — not something
  to build into the reproducible-server story here.

### 1.3 `Dockerfile.sync-server`

```dockerfile
# --- build the static app ---
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# (server/ is the new sync-server source, added alongside src/ — see
#  architecture doc §8 for what it contains)
RUN pnpm --filter sync-server build 2>/dev/null || pnpm build:server

# --- runtime ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
EXPOSE 3000
CMD ["node", "server-dist/index.js"]
```

The implemented sync server lives in this repository's `server/` directory
and builds to `server-dist/`. The same process serves both `dist/` and the
sync endpoints, keeping the deployable to one application image plus Redis,
Neo4j, and the reverse proxy.

### 1.4 `Caddyfile`

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

### 1.5 `.env.example`

```
NEO4J_PASSWORD=change-me-to-a-long-random-value
SYNC_DOMAIN=sync.example.org
```

Copy to `.env`, fill in real values, never commit `.env` (already covered
by this repo's existing `.gitignore` pattern for secrets — extend it with
`deploy/.env` if the file lives there).

### 1.6 Bring-up and backups

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

## 3. Configuration reference

| Variable | Where | Purpose |
|---|---|---|
| `REDIS_URL` | sync-server, materializer | e.g. `redis://127.0.0.1:6379` |
| `NEO4J_URL` | sync-server, materializer | Bolt URL, e.g. `bolt://127.0.0.1:7687` |
| `NEO4J_USER` / `NEO4J_PASSWORD` | sync-server, materializer | Neo4j credentials |
| `PORT` | sync-server | HTTP port to listen on |
| `VAULT_CREATE_RATE_LIMIT` / `VAULT_CREATE_RATE_WINDOW_SECONDS` | sync-server | `POST /sync/vaults` abuse limit (default 10 per hour per client IP — see architecture doc §9); trusts `X-Forwarded-For`, so only meaningful behind a reverse proxy that sets it truthfully |
| `TOMBSTONE_RETENTION_MS` / `TOMBSTONE_SWEEP_INTERVAL_MS` | materializer | how long a deleted record's tombstone is kept before purging, and how often the sweep runs (architecture doc §5) |

Vault tokens themselves need no server-side secret to configure: each is a
random opaque bearer value generated at vault-creation time, stored only
as a salted-in-practice-by-high-entropy SHA-256 hash per vault in Redis and
Neo4j (`vaultStore.ts`) — there's no server-wide signing key, so there's nothing
here to generate or rotate at the deployment level. A leaked *vault*
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
suspect proxy buffering first (§1.4 / §2.4) before suspecting the server.

The ticket can still appear in access logs, but it is stream-only and expires
after one hour. Configure the public proxy to redact query strings on
`/sync/stream` where possible; unlike the original design, the long-lived
vault bearer token never appears in that URL.
