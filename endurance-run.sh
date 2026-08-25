#!/usr/bin/env bash
# The multi-hour, multi-tenant endurance run (docs/roadmap.md, "Multi-hour
# endurance run").
#
# Builds the real client and server, starts the real sync-server and a real
# materializer as separate OS processes (not the docker deploy stack, and
# not in-process fakes), waits for them to report healthy, then drives many
# real headless-Chromium browser contexts against them for hours - each one
# a simulated tenant doing real clicks in the real app: creating records,
# editing them, occasionally deleting them, with a fraction of tenants
# running two devices on one vault to exercise sustained multi-device
# convergence. See server/test/browserEndurance.ts for what actually
# generates the load and checks correctness; this script's job is standing
# the real stack up around it and getting the results back to you afterward.
#
# Usage:
#   ./endurance-run.sh                    # 6h default, sized to this machine
#   ENDURANCE_DURATION_MS=14400000 ./endurance-run.sh    # 4h
#   ENDURANCE_TENANT_COUNT=150 ./endurance-run.sh         # override sizing
#
# Meant to be run inside tmux: it runs in the foreground, prints a progress
# block every few minutes, and everything it prints is also captured to
# endurance-runs/<timestamp>/harness.log - detach and reattach freely, or
# close the terminal and `tmux attach` later. Nothing is deleted on exit,
# success or failure: endurance-runs/<timestamp>/ keeps every log and the
# full metrics.json (and crash.json, if something broke) for later review.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

banner() { printf '\n%s\n' "================================================================================"; }
say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$1"; }

banner
say "endurance-run.sh: preflight checks"
banner

# --- OS -----------------------------------------------------------------
# A soft check, not a hard gate: a Debian-derived distro (Ubuntu etc.) is
# fine, and refusing to run elsewhere would be its own kind of surprise.
# This is here so the run's own log records what it actually ran on.
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_DESC="${PRETTY_NAME:-$ID}"
  case "${ID:-}${ID_LIKE:-}" in
    *debian*) say "OS: $OS_DESC (Debian-family, as expected)" ;;
    *) say "OS: $OS_DESC - WARNING: not detected as Debian-family; proceeding anyway" ;;
  esac
else
  say "OS: could not read /etc/os-release - proceeding anyway"
fi

# --- Node / pnpm ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "endurance-run.sh: node is not on PATH." >&2
  exit 1
fi
NODE_VERSION=$(node --version)
say "node: $NODE_VERSION (need >=22.18, per package.json engines)"
if ! command -v pnpm >/dev/null 2>&1; then
  echo "endurance-run.sh: pnpm is not on PATH (npm i -g pnpm)." >&2
  exit 1
fi
say "pnpm: $(pnpm --version)"

# --- Secrets / config -------------------------------------------------------
if [ -f "$SCRIPT_DIR/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.env.local"
  set +a
fi
if [ -z "${NEO4J_PASSWORD:-}" ]; then
  echo "endurance-run.sh: NEO4J_PASSWORD is not set - export it or copy .env.example to .env.local (see secrets.md)." >&2
  exit 1
fi
say "NEO4J_PASSWORD: set"

# --- Redis reachability ------------------------------------------------
if command -v redis-cli >/dev/null 2>&1; then
  if redis-cli ${REDIS_URL:+-u "$REDIS_URL"} ping >/dev/null 2>&1; then
    say "Redis: reachable"
  else
    echo "endurance-run.sh: Redis does not answer PING. Install/start it first:" >&2
    echo "  sudo apt-get install redis-server && sudo systemctl start redis-server" >&2
    exit 1
  fi
else
  say "Redis: redis-cli not found, skipping the direct check (the server's own boot will fail loudly if it can't reach Redis)"
fi
say "Neo4j: not checked directly here - the sync server verifies connectivity on startup and this script reads its log if that fails"

# --- Playwright's Chromium -------------------------------------------------
if [ -x /usr/bin/chromium ]; then
  say "Chromium: system /usr/bin/chromium found, will be used directly"
else
  say "Chromium: /usr/bin/chromium not found, checking Playwright's own browser install..."
  if ! npx --no-install playwright --version >/dev/null 2>&1; then
    echo "endurance-run.sh: @playwright/test is not installed (pnpm install first)." >&2
    exit 1
  fi
  if ! npx --no-install playwright install --dry-run chromium >/dev/null 2>&1; then
    say "Chromium: installing Playwright's bundled build (npx playwright install chromium)..."
    npx playwright install chromium
  else
    say "Chromium: Playwright's bundled build is already installed"
  fi
fi

# --- Hardware detection and load sizing ------------------------------------
banner
say "endurance-run.sh: hardware detection and load sizing"
banner

CPU_COUNT=$(nproc 2>/dev/null || echo 1)
MEM_AVAILABLE_MB=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
say "detected: $CPU_COUNT CPUs, ${MEM_AVAILABLE_MB} MiB available RAM"

if [ -z "${ENDURANCE_TENANT_COUNT:-}" ]; then
  # Real headless Chromium contexts under sustained real-app load run
  # noticeably heavier than an idle tab - budgeted generously here (300 MiB
  # per tenant) rather than tuned to a bare-minimum figure that would starve
  # Redis/Neo4j/Node of headroom on the same box. Also capped by CPU count
  # (12 contexts/core) so a huge-RAM, few-core box doesn't spawn more
  # concurrent renderers than it can actually schedule. Floor 20, ceiling
  # 300 either way - override with ENDURANCE_TENANT_COUNT if this machine's
  # shape calls for something outside that band.
  MEM_BASED=$((MEM_AVAILABLE_MB / 300))
  CPU_BASED=$((CPU_COUNT * 12))
  COMPUTED=$MEM_BASED
  if [ "$CPU_BASED" -lt "$COMPUTED" ]; then COMPUTED=$CPU_BASED; fi
  if [ "$COMPUTED" -lt 20 ]; then COMPUTED=20; fi
  if [ "$COMPUTED" -gt 300 ]; then COMPUTED=300; fi
  export ENDURANCE_TENANT_COUNT=$COMPUTED
  say "tenant count: $ENDURANCE_TENANT_COUNT (auto-sized: min(${MEM_AVAILABLE_MB}MiB/300MiB=$MEM_BASED, ${CPU_COUNT}*12=$CPU_BASED), clamped to [20,300])"
else
  say "tenant count: $ENDURANCE_TENANT_COUNT (explicitly set via ENDURANCE_TENANT_COUNT)"
fi

DURATION_MS="${ENDURANCE_DURATION_MS:-21600000}"
export ENDURANCE_DURATION_MS="$DURATION_MS"
DURATION_HOURS=$(awk -v ms="$DURATION_MS" 'BEGIN { printf "%.1f", ms/3600000 }')
say "duration: ${DURATION_MS}ms (~${DURATION_HOURS}h) - override with ENDURANCE_DURATION_MS"

# --- Build ------------------------------------------------------------
banner
say "endurance-run.sh: building client and server (production builds, not dev/watch mode)"
banner
pnpm build
pnpm build:server

# --- Run directory ----------------------------------------------------
RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)
RUN_DIR="$SCRIPT_DIR/endurance-runs/$RUN_ID"
mkdir -p "$RUN_DIR"
say "run directory: $RUN_DIR (nothing here is ever deleted by this script)"

{
  echo "run id: $RUN_ID"
  echo "started at (UTC): $(date -u --iso-8601=seconds)"
  echo "host: $(hostname), OS: ${OS_DESC:-unknown}"
  echo "CPUs: $CPU_COUNT, available RAM at start: ${MEM_AVAILABLE_MB} MiB"
  echo "node: $NODE_VERSION, pnpm: $(pnpm --version)"
  echo "git commit: $(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo
  echo "--- environment (ENDURANCE_* only) ---"
  env | grep '^ENDURANCE_' | sort || true
} > "$RUN_DIR/run-config.txt"
say "run config recorded: $RUN_DIR/run-config.txt"

# --- Start the real server + materializer ----------------------------------
banner
say "endurance-run.sh: starting the real sync-server and materializer"
banner

SYNC_SERVER_PID=""
MATERIALIZER_PID=""
HARNESS_PID=""

cleanup() {
  local exit_code=$?
  banner
  say "endurance-run.sh: cleaning up (exit code so far: $exit_code)"
  if [ -n "$HARNESS_PID" ] && kill -0 "$HARNESS_PID" 2>/dev/null; then
    say "stopping the still-running harness (pid $HARNESS_PID) with SIGTERM, giving it time for a graceful final reconciliation..."
    kill -TERM "$HARNESS_PID" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "$HARNESS_PID" 2>/dev/null || break
      sleep 2
    done
    kill -0 "$HARNESS_PID" 2>/dev/null && kill -KILL "$HARNESS_PID" 2>/dev/null || true
  fi
  for pid in "$SYNC_SERVER_PID" "$MATERIALIZER_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
  for pid in "$SYNC_SERVER_PID" "$MATERIALIZER_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  banner
  say "endurance-run.sh: done. Everything is in $RUN_DIR:"
  echo "  harness.log        - the full verbose run log (also what was on your terminal)"
  echo "  sync-server.log    - the real server process's own log"
  echo "  materializer.log   - the real materializer process's own log"
  echo "  metrics.json       - structured samples: RSS, fd counts, Redis memory, actions, errors, over time"
  echo "  crash.json         - present only if an invariant was actually breached, with full context"
  echo "  run-config.txt     - exact config and hardware this run used"
  banner
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

PORT="${PORT:-3000}"
export PORT
export STATIC_DIR="$SCRIPT_DIR/dist"

node server-dist/index.js > "$RUN_DIR/sync-server.log" 2>&1 &
SYNC_SERVER_PID=$!
say "sync-server started, pid $SYNC_SERVER_PID, log: $RUN_DIR/sync-server.log"

ROLE=materializer node server-dist/index.js > "$RUN_DIR/materializer.log" 2>&1 &
MATERIALIZER_PID=$!
say "materializer started, pid $MATERIALIZER_PID, log: $RUN_DIR/materializer.log"

say "waiting for the sync server to report healthy on 127.0.0.1:${PORT}..."
HEALTHY=0
for _ in $(seq 1 90); do
  if ! kill -0 "$SYNC_SERVER_PID" 2>/dev/null; then
    echo "endurance-run.sh: sync-server exited before becoming healthy. Its log:" >&2
    cat "$RUN_DIR/sync-server.log" >&2
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:${PORT}/sync/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 2
done
if [ "$HEALTHY" -ne 1 ]; then
  echo "endurance-run.sh: sync server never became healthy after 3 minutes. Last 60 lines of its log:" >&2
  tail -n 60 "$RUN_DIR/sync-server.log" >&2
  exit 1
fi
say "sync server is healthy"

# --- Run the harness --------------------------------------------------
banner
say "endurance-run.sh: starting the browser-driven endurance harness"
say "this runs in the foreground for the full duration - detach tmux and come back any time"
say "live progress: this terminal, and $RUN_DIR/harness.log"
banner

export ENDURANCE_BASE_URL="http://127.0.0.1:${PORT}"
export ENDURANCE_SYNC_SERVER_PID="$SYNC_SERVER_PID"
export ENDURANCE_MATERIALIZER_PID="$MATERIALIZER_PID"
export ENDURANCE_METRICS_FILE="$RUN_DIR/metrics.json"
export ENDURANCE_CRASH_FILE="$RUN_DIR/crash.json"

set +e
# Not `pnpm exec tsx ... | tee ...` backgrounded as one pipeline: `$!` would
# then be tee's pid, not the harness's, and SIGTERM on cleanup would signal
# the wrong process - the harness would never get the chance to run its own
# graceful-shutdown path (final reconciliation, a real summary instead of a
# truncated metrics file). The direct binary, not `pnpm exec`, for the same
# reason: `$!` has to be the actual Node process running the harness, not a
# wrapper that might not forward the signal.
"$SCRIPT_DIR/node_modules/.bin/tsx" server/test/browserEndurance.ts > >(tee "$RUN_DIR/harness.log") 2>&1 &
HARNESS_PID=$!
wait "$HARNESS_PID"
HARNESS_EXIT=$?
set -e
HARNESS_PID=""

if [ "$HARNESS_EXIT" -eq 0 ]; then
  say "harness completed successfully"
else
  say "harness exited with status $HARNESS_EXIT - see crash.json and harness.log above"
fi

exit "$HARNESS_EXIT"
