# Localgraph Session Handoff

## Current Status

**Clean.** All suites pass: 136/136 client (Playwright), 78/78 server (node --test), 4/4 offline. No known failing tests, no open bugs.

### Test harnesses (fuzz / stress / security)

1. **`pnpm fuzz`** — Random walk through datalet operations (create/join/leave/archive/switch) against a storing fake sync server, checking invariants after each step, stopping at first breach. `FUZZ_SEED` / `FUZZ_STEPS` env vars.
2. **`pnpm stress`** — Concurrent writers hammering the real HTTP server with large payloads and awkward timing, to find logic faults (races, quota edge cases, idempotency) rather than to load-test the box. `STRESS_SEED` / `STRESS_VAULTS` / `STRESS_WRITERS` / `STRESS_ROUNDS` / `STRESS_RECORD_BYTES`.
3. **`server/test/securityHttp.test.ts`** — Cross-tenant token isolation, vault-id guessing/glob injection into Redis key scans, Cypher label injection (`sanitizeLabel`), Unicode/collation round-trip (RTL override, zero-width, astral emoji, Turkish dotless i), UTF-8-vs-UTF-16 quota accounting. All 5 pass.
4. **`tests/security-import.spec.ts`** — Client-side backup-import attacks: prototype pollution, cross-graph writes, whole-file rejection on partial malformed input, oversized record counts, script-in-record-value XSS. All 6 pass.

All four print progress continuously (per-step, per-case) rather than going silent until a summary — load-bearing for watching a long run via Ctrl+O without wondering if it's hung. This is now a standing rule, saved to memory (`feedback_verbose_long_tests.md`).

### Invite-token links (this session's main work)

New feature: a COPY or PAIR code can be wrapped in a disposable, single-use link instead of sharing the human-typable code directly — the pattern Zoom uses for meeting invites.

- **`server/src/pairCode.ts`**: code entropy doubled from 40 to 80 bits (`randomBytes(10)`, 16-character payload). COPY codes also gained a 30-day TTL (`COPY_CODE_TTL_SECONDS`) — previously durable/forever, which was too weak for a persistent secret at the old entropy. All user-facing copy updated ("valid for 30 days" instead of "durable copy").
- **`server/src/vaultStore.ts`**: `createInviteToken(codeType, code)` mints a single-use UUID token wrapping a code, 7-day TTL (`INVITE_TOKEN_TTL_SECONDS`). `redeemInviteToken(codeType, token)` redeems it via `GETDEL` (atomic, single-use by construction).
- **HTTP**: `POST /sync/invite-token` (mint) and `POST /sync/invite-redeem` (redeem) in `server/src/httpServer.ts`. Redemption is rate-limited the same as pair/clone redemption.
- **Client**: `src/pages/JoinPage.tsx` at `/join?token=<uuid>`. Redeems the token (tries COPY then PAIR), shows a confirmation step, then acts as if the recovered code had been pasted in. Wired into `src/router.tsx`.
- **`server/test/inviteTokenHttp.test.ts`**: full round trip against a real HTTP server + Redis (not mocks) — mint → redeem once (succeeds) → redeem again (refused, single-use) → cross-type redemption refused → never-issued token refused → malformed code refused at mint time.

**Design decisions made, in case they need revisiting:**
- Token in a query param (`?token=`), not a URL fragment — considered fragment-only (never reaches server logs) but a plain query param was judged acceptable given the token is single-use + 7-day TTL, so a leaked link is worthless after one redemption or one week.
- 7-day TTL chosen over 24h (too tight — normal reply-tomorrow friction) or 30 days (too loose for a single link, even though the underlying code lives that long). Codes and their invite tokens now have deliberately different lifetimes for this reason.
- Token type (COPY vs PAIR) is explicit in the API (`codeType` field), not inferred, so a token can't be redeemed as the wrong kind.

### NOT yet built (was the plan, ran out of session)

1. **"Copy as Link" button** — `src/components/CloneCodes.tsx` only has "Copy" (the raw code) today. No UI calls `POST /sync/invite-token` yet. The endpoint and page work; nothing in the product surfaces them.
2. **Smart input parsing** — pasting a full `https://datalet.app/join?token=...` URL, or a bare token, into the existing code-entry field (`DataletSettings.tsx`, the `LG1-… or COPY-…` input) is not handled. Right now only `/join` itself redeems a token; the plain code field only accepts codes.
3. **`/join` page polish** — functional but minimal. No vault metadata shown before confirming (whose vault, size, etc.) — just "someone is offering you a copy" / code type. Worth a design pass before shipping to real users.

If picking this up: start with #1 and #2 together, since a "Copy as Link" button is pointless until pasting the link somewhere actually works.

### Known non-bugs (don't re-chase these)

- **`pnpm test:server` used to hang forever after all tests passed.** Root cause: `fetch()`'s connection pool (undici) leaves an idle keep-alive socket open per ephemeral-port test server, even after `server.close()` + `closeAllConnections()`. Not a real leak — confirmed via `--test-force-exit` (Node 22's documented fix for this exact class of issue), which now runs clean in ~10-13s. It's in the `test:server` script in `package.json`; don't remove it without re-verifying.
- **If a security/invite/stress test run against the local dev Redis returns confusing "unknown vault" or "not found" errors after repeated manual runs**, check the rate-limit keys before assuming a real bug: `redis-cli keys "rate:vault-create:*"` — `VAULT_CREATE_RATE_LIMIT` is 10/window by default and repeated debug runs from the same IP exhaust it fast. `redis-cli del "rate:vault-create:::ffff:127.0.0.1"` clears it. This cost a long detour this session.

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

**Live on nuc at https://datalet.app**, advertised to no one. Deploy is `ssh nuc`, `git pull`, `./deploy/up.sh` in the deploy folder. Docker volumes (Neo4j + Redis) were fully wiped earlier this session at the user's request — clean slate, no stale vaults. `.env` was preserved. Nothing in this session's work requires a new env var or a data migration.

---

**Previous session:** Fixed the pairing/leave-vault data-loss bugs, built the fuzzer (found a real bug on its first run), split soak testing into correctness (fuzz) vs endurance (resources), fixed a broken `pnpm fuzz` default invocation.

**This session:** Verified and closed out the security suite (was already fine — earlier "failure" was a flaky/stale run, confirmed 5/5 clean). Audited COPY/PAIR code entropy (was 40 bits, weak for a "durable" secret) and fixed it (80 bits + 30-day TTL). Designed and built invite-token links end-to-end (server functions, HTTP routes, `/join` page, full e2e test) per user's request, modeled on Zoom-style disposable meeting links. Fixed a real `pnpm test:server` hang (`--test-force-exit`) discovered while testing the new feature. UI wiring (Copy-as-Link button, smart paste parsing) intentionally left for next session — see "NOT yet built" above.
