# Localgraph Session Handoff

## Current Status

**Clean.** All suites pass: 190 client Playwright tests (+1 intentionally
skipped), 79/79 server (node --test, integration required), 4/4 offline, the
real-scale copy smoke (`pnpm test:smoke:copy-scale`), the real two-device user
story (`pnpm test:smoke:user-story-sync`), and the real source/copy story
(`pnpm test:smoke:user-story-copy`). Nothing is currently open on the roadmap.

For what's changed recently and why, see
[`docs/build-history.md`](docs/build-history.md) (defects found, root causes,
fixes, how each was verified) rather than this file — that's the one place
this project keeps that record, so it doesn't drift out of sync with a second
copy here. For what's left, deferred, or out of scope on purpose, see
[`docs/roadmap.md`](docs/roadmap.md).

### Known non-bugs (don't re-chase these)

- **`pnpm test:server` used to hang forever after all tests passed.** Root cause: `fetch()`'s connection pool (undici) leaves an idle keep-alive socket open per ephemeral-port test server, even after `server.close()` + `closeAllConnections()`. Not a real leak — confirmed via `--test-force-exit` (Node 22's documented fix for this exact class of issue), which now runs clean in ~10-13s. It's in the `test:server` script in `package.json`; don't remove it without re-verifying.
- **If a security/invite/stress test run against the local dev Redis returns confusing "unknown vault" or "not found" errors after repeated manual runs**, check the rate-limit keys before assuming a real bug: `redis-cli keys "rate:vault-create:*"` — `VAULT_CREATE_RATE_LIMIT` is 10/window by default and repeated debug runs from the same IP exhaust it fast. `redis-cli del "rate:vault-create:::ffff:127.0.0.1"` clears it.

### Test harnesses (fuzz / stress / security)

1. **`pnpm fuzz`** — Random walk through datalet operations (create/join/leave/archive/switch) against a storing fake sync server, checking invariants after each step, stopping at first breach. `FUZZ_SEED` / `FUZZ_STEPS` env vars.
2. **`pnpm stress`** — Concurrent writers hammering the real HTTP server with large payloads and awkward timing, to find logic faults (races, quota edge cases, idempotency) rather than to load-test the box. `STRESS_SEED` / `STRESS_VAULTS` / `STRESS_WRITERS` / `STRESS_ROUNDS` / `STRESS_RECORD_BYTES`.
3. **`./endurance-run.sh`** — Real multi-hour, multi-tenant endurance run: builds and starts the real server + materializer, drives many real headless-Chromium tenants against them. See its own `--help`-style header comment and `server/test/browserEndurance.ts` for env vars.
4. **`server/test/securityHttp.test.ts`** — Cross-tenant token isolation, vault-id guessing/glob injection into Redis key scans, Cypher label injection (`sanitizeLabel`), Unicode/collation round-trip, UTF-8-vs-UTF-16 quota accounting.
5. **`tests/security-import.spec.ts`** — Client-side backup-import attacks: prototype pollution, cross-graph writes, whole-file rejection on partial malformed input, oversized record counts, script-in-record-value XSS.

All print progress continuously (per-step, per-case) rather than going silent until a summary — load-bearing for watching a long run without wondering if it's hung. Standing rule, saved to memory (`feedback_verbose_long_tests.md`).

### Memory / Rules

See `~/.claude/projects/-home-user-Code-localgraph/memory/`:
- `feedback_verbose_long_tests.md` — mandatory progress logging for fuzz/stress/security harnesses
- `localgraph-fuzz-stress-security.md` — what each harness covers, where it lives

### Commands

```bash
# Fuzzer
pnpm fuzz                                    # short random walk
FUZZ_STEPS=200 pnpm fuzz                     # longer walk, same harness
FUZZ_SEED=12345 FUZZ_STEPS=200 pnpm fuzz     # replay an exact walk

# Stress
pnpm stress
STRESS_SEED=42 STRESS_VAULTS=4 STRESS_WRITERS=3 STRESS_ROUNDS=20 pnpm stress

# Full suites
pnpm test            # client (Playwright) + server (node --test)
pnpm test:server      # server only, ~10-13s, clean exit
pnpm test:offline     # PWA/offline-shell checks

# One server test file
npx tsx --env-file-if-exists=.env.local --test server/test/inviteTokenHttp.test.ts
```

### Deployment

**Live on nuc at https://datalet.app**, advertised to no one. Deploy is `ssh nuc`, `git pull`, `./deploy/up.sh` in the deploy folder.
