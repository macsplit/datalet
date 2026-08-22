#!/bin/sh
# Bring the sync tier up, or update it in place.
#
# Safe to re-run: it builds, restarts what changed, and leaves the volumes
# alone. The health check at the end is the point - a stack that starts but
# cannot answer is the failure worth catching here rather than from a browser.
set -e

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! docker compose version >/dev/null 2>&1; then
  echo "up.sh: needs Docker Compose v2 (try: docker compose version)" >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "up.sh: created deploy/.env from the example."
  echo "up.sh: set NEO4J_PASSWORD in it, then run this again." >&2
  exit 1
fi

# shellcheck disable=SC1091
. ./.env
if [ -z "$NEO4J_PASSWORD" ] || [ "$NEO4J_PASSWORD" = "change-me-to-a-long-random-value" ]; then
  echo "up.sh: set a real NEO4J_PASSWORD in deploy/.env first." >&2
  exit 1
fi

echo "up.sh: building and starting…"
docker compose up -d --build

PORT="${SYNC_PORT:-3000}"
echo "up.sh: waiting for the sync server on 127.0.0.1:${PORT}…"
i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS "http://127.0.0.1:${PORT}/sync/health" >/dev/null 2>&1; then
    echo "up.sh: healthy."
    echo
    docker compose ps
    echo
    echo "Point your tunnel or reverse proxy at 127.0.0.1:${PORT}."
    echo "The same port serves the app and /sync/*, which is what keeps them"
    echo "on one origin as the Content Security Policy requires."
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "up.sh: no healthy response after 2 minutes. Recent logs:" >&2
docker compose logs --tail 40 sync-server >&2
exit 1
