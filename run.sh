#!/bin/sh
# Starts the full local dev stack: the sync-server + materializer (backing
# /sync/* - see server/ and docs/remote-sync-architecture.md) alongside the
# Vite client. Requires Redis and Neo4j already running (see secrets.md)
# and NEO4J_PASSWORD exported in your shell.
set -e

if [ -z "$NEO4J_PASSWORD" ]; then
  echo "run.sh: NEO4J_PASSWORD is not set - export it first (see secrets.md)." >&2
  exit 1
fi

if command -v redis-cli >/dev/null 2>&1 && ! redis-cli ping >/dev/null 2>&1; then
  echo "run.sh: warning - Redis doesn't seem to be reachable; /sync/* will fail." >&2
fi

cleanup() {
  kill "$SYNC_SERVER_PID" "$MATERIALIZER_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

pnpm dev:server &
SYNC_SERVER_PID=$!
pnpm dev:materializer &
MATERIALIZER_PID=$!

/usr/bin/pnpm dev --host
