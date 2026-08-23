# Localgraph Session Handoff

## Current Status (as of today)

**All systems operational.** The git repo is clean, no uncommitted changes. The major remaining work is verification and polish of the new test harnesses.

### What Was Accomplished

Three major harnesses were built to verify logic under realistic conditions:

1. **`pnpm fuzz`** (Playwright) — Random walk through datalet operations (create/join/leave/archive/switch) against a storing fake sync server, checking invariants after each step. Stops at first breach. Environment: `FUZZ_SEED` / `FUZZ_STEPS`.

2. **`pnpm stress`** (Node.js/HTTP) — Concurrent writers hammering the real server with large payloads and awkward timing. Finds logic faults (races, quota edge cases, idempotency). Environment: `STRESS_SEED` / `STRESS_VAULTS` / `STRESS_WRITERS` / `STRESS_ROUNDS` / `STRESS_RECORD_BYTES`.

3. **`server/test/securityHttp.test.ts`** (Node.js) — OWASP checks: cross-tenant token isolation, vault-id guessing/glob injection, Cypher label injection, Unicode/collation round-trip, UTF-8 vs UTF-16 quota accounting.

4. **`tests/security-import.spec.ts`** (Playwright) — Client-side backup-import attacks: prototype pollution, cross-graph writes, whole-file rejection, oversized records, script-in-value XSS.

**Progress logging is now mandatory**: all three harnesses log per-step/per-case, not just start/end. This allows watching via `Ctrl+O` without confusion about whether it's hung.

### Known Issues / Last Checkpoint

One test was failing: `"awkward text survives a round trip through Redis and Neo4j unchanged"` in `server/test/securityHttp.test.ts`. The progress logging was added to that file to make diagnosis easier on the next run. The failure was `assert.ok(stored, ...)` — the record wasn't in the snapshot, not a value mismatch. Likely causes:

- RTL-override/zero-width string breaking key construction in `patchBody()`
- Timing issue: materializer not caught up before `snapshot()` reads

The test harnesses are otherwise passing. `tests/fuzz.spec.ts` and `server/test/stress.ts` still need the same per-step progress logging added (marked as mandatory by the memory rule).

### Key Files

- `tests/fuzz.spec.ts` — The fuzzer, with supporting fake server and invariants in `tests/support/`
- `tests/datalet-flows.spec.ts` — Composed flow regression tests (created on import, pairing carries records, leaving keeps records + vault)
- `tests/security-import.spec.ts` — Client-side import security (6/6 passing)
- `server/test/securityHttp.test.ts` — Server-side security checks (4/5 passing, 1 timeout/diagnosis pending)
- `server/test/stress.ts` — Stress harness (not yet run with verbose logging)
- `server/test/migrationRoundTrip.test.ts` — Round-trip validation (client patches → server applier → client validator)

### Memory / Rules

See `~/.claude/projects/-home-user-Code-localgraph/memory/`:
- `feedback_verbose_long_tests.md` — Mandatory progress logging for fuzz/stress/security
- `localgraph-fuzz-stress-security.md` — Full description of what each harness covers

### Next Steps (in priority order)

1. **Diagnose and fix the one failing security test** — Run with verbose logging, identify which string/case fails, fix in `securityHttp.test.ts`
2. **Add progress logging to `stress.ts` and `fuzz.spec.ts`** — Already in security test, needs rollout to the other two
3. **Full verification run** — `pnpm test` (client), `pnpm test:server`, `pnpm test:offline`, `pnpm fuzz` (30+ steps), `pnpm stress` (sample config)
4. **Commit and push** — All harnesses working with progress logging in place

### Commands to Know

```bash
# Quick smoke test
FUZZ_SEED=1 FUZZ_STEPS=5 pnpm fuzz

# Full fuzz walk
FUZZ_STEPS=200 pnpm fuzz

# Stress with reasonable defaults
pnpm stress

# Stress with explicit config
STRESS_SEED=42 STRESS_VAULTS=4 STRESS_WRITERS=3 STRESS_ROUNDS=20 pnpm stress

# One security test (to diagnose the failing one)
npx tsx --env-file-if-exists=.env.local --test server/test/securityHttp.test.ts
```

### Deployment Status

**Live on nuc at https://datalet.app** — The fixes pushed last session are in production. No users, but the stack runs continuously. Docker volumes are zeroed out and fresh. The next `git pull && ./deploy/up.sh` brings in all new harnesses.

---

**Last checkpoint session:** Fixed encoding bug in record migration, added fuzzer to catch compositions, split soak/endurance from correctness. This session: finished harness scaffolding, added progress logging (pending one test fix).

