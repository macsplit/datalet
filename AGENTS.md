# Localgraph Session Handoff

## Current Status

**Clean.** All suites pass: 143/143 client (Playwright), 78/78 server (node --test), 4/4 offline. No known failing tests, no open bugs.

### Test harnesses (fuzz / stress / security)

1. **`pnpm fuzz`** — Random walk through datalet operations (create/join/leave/archive/switch) against a storing fake sync server, checking invariants after each step, stopping at first breach. `FUZZ_SEED` / `FUZZ_STEPS` env vars.
2. **`pnpm stress`** — Concurrent writers hammering the real HTTP server with large payloads and awkward timing, to find logic faults (races, quota edge cases, idempotency) rather than to load-test the box. `STRESS_SEED` / `STRESS_VAULTS` / `STRESS_WRITERS` / `STRESS_ROUNDS` / `STRESS_RECORD_BYTES`.
3. **`server/test/securityHttp.test.ts`** — Cross-tenant token isolation, vault-id guessing/glob injection into Redis key scans, Cypher label injection (`sanitizeLabel`), Unicode/collation round-trip (RTL override, zero-width, astral emoji, Turkish dotless i), UTF-8-vs-UTF-16 quota accounting. All 5 pass.
4. **`tests/security-import.spec.ts`** — Client-side backup-import attacks: prototype pollution, cross-graph writes, whole-file rejection on partial malformed input, oversized record counts, script-in-record-value XSS. All 6 pass.

All four print progress continuously (per-step, per-case) rather than going silent until a summary — load-bearing for watching a long run via Ctrl+O without wondering if it's hung. This is now a standing rule, saved to memory (`feedback_verbose_long_tests.md`).

### Invite-token links

New feature: a COPY or PAIR code can be wrapped in a disposable, single-use link instead of sharing the human-typable code directly — the pattern Zoom uses for meeting invites.

- **`server/src/pairCode.ts`**: code entropy doubled from 40 to 80 bits (`randomBytes(10)`, 16-character payload). COPY codes also gained a 30-day TTL (`COPY_CODE_TTL_SECONDS`) — previously durable/forever, which was too weak for a persistent secret at the old entropy. All user-facing copy updated ("valid for 30 days" instead of "durable copy").
- **`server/src/vaultStore.ts`**: `createInviteToken(codeType, code)` mints a single-use UUID token wrapping a code, 7-day TTL (`INVITE_TOKEN_TTL_SECONDS`). `redeemInviteToken(codeType, token)` redeems it via `GETDEL` (atomic, single-use by construction).
- **HTTP**: `POST /sync/invite-token` (mint) and `POST /sync/invite-redeem` (redeem) in `server/src/httpServer.ts`. Redemption is rate-limited the same as pair/clone redemption.
- **Client**: `src/pages/JoinPage.tsx` at `/join?token=<uuid>`. Redeems the token (tries COPY then PAIR), shows a confirmation step, then genuinely completes the join/copy — calls `redeemDataletCode` + `adoptVaultAsDatalet` directly, the same as the manual-paste path, rather than copying to clipboard and dumping the user back at Settings to paste it in a second time. Wired into `src/router.tsx`.
- **`src/utils/codeRedemption.ts`** (new, this follow-up session): the code-type-branching logic (`COPY`/`PAIR`/`LG1`) that used to live only in `DataletSettings.tsx` is now `redeemDataletCode`, shared by both the manual field and `/join`. Also holds `extractInviteToken` (recognizes a pasted invite link or bare token) and `redeemInviteToken` (tries COPY then PAIR against `/sync/invite-redeem`).
- **`src/components/CloneCodes.tsx`**: "Copy as Link" button next to "Copy" on each COPY code, calling `POST /sync/invite-token` and copying the resulting `/join?token=...` URL. Its "Copied" state is tracked separately from the plain "Copy" button's (`code:<value>` vs `link:<value>` keys) so pressing one doesn't falsely flip the other.
- **`src/components/DataletSettings.tsx`**: the "Or open one from a code" field now recognizes a pasted invite link (or its bare token) via `extractInviteToken`, exchanges it for the code it wraps, then proceeds exactly as if the code itself had been pasted.
- Deliberately **not** wired up for PAIR's temporary code (`SyncSettings.tsx`, the 10-minute pairing exchange): wrapping a 10-minute code in a 7-day link would look like a week-long invite that silently stops working after 10 minutes. The backend already supports `codeType: "PAIR"` for future use; only the UI trigger was withheld.
- **`server/test/inviteTokenHttp.test.ts`**: full round trip against a real HTTP server + Redis (not mocks) — mint → redeem once (succeeds) → redeem again (refused, single-use) → cross-type redemption refused → never-issued token refused → malformed code refused at mint time.
- **`tests/join.spec.ts`** (new) and **`tests/clone-codes.spec.ts`** (extended): COPY and PAIR links redeem and complete the join without a second manual paste; an expired/reused token shows a clear message; a link with no token doesn't hang; the same `canLeaveActiveDatalet` data-loss guard the manual field uses also blocks joining via a link; "Copy as Link" mints correctly and its state is independent of "Copy"; pasting a full link into the manual field joins successfully.

**Design decisions made, in case they need revisiting:**
- Token in a query param (`?token=`), not a URL fragment — considered fragment-only (never reaches server logs) but a plain query param was judged acceptable given the token is single-use + 7-day TTL, so a leaked link is worthless after one redemption or one week.
- 7-day TTL chosen over 24h (too tight — normal reply-tomorrow friction) or 30 days (too loose for a single link, even though the underlying code lives that long). Codes and their invite tokens now have deliberately different lifetimes for this reason.
- Token type (COPY vs PAIR) is explicit in the API (`codeType` field), not inferred, so a token can't be redeemed as the wrong kind.
- PAIR's UI trigger withheld (see above) — worth reconsidering if a use case for a longer-lived PAIR flow ever emerges.

### A real bug this follow-up session found and fixed in `JoinPage.tsx`

The confirm screen computed `canLeaveActiveDatalet()` once, inline, at render. `DataletSettings.tsx` deliberately re-polls that same check every second, because the commonest refusal - a queued outbox - clears itself moments later as changes sync, asynchronously and outside React's knowledge; computed only once, a screen that isn't otherwise re-rendering never notices the refusal clear, and its button stays disabled indefinitely. `JoinPage.tsx` now polls the same way. Caught by an end-to-end test, not by inspection - the fix was verified by deliberately reverting it and confirming the test fails, then restoring it and confirming the test passes.

### Also fixed: a broken sentence from the entropy/TTL session

A blind text-replace two sessions ago (`"durable copy"` → `"valid for 30 days"`, meant for the COPY-code description) also matched an unrelated sentence in the permanent-erasure warning describing what gets removed from the server, leaving `"...and the server's own\nvalid for 30 days"` - a sentence fragment shown to anyone erasing a datalet. No test asserted that exact text, so it shipped silently for two sessions. Restored via `git log -p` to find the original wording.

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

**Prior session:** Verified and closed out the security suite. Audited COPY/PAIR code entropy (was 40 bits, weak for a "durable" secret) and fixed it (80 bits + 30-day TTL). Designed and built invite-token links end-to-end (server functions, HTTP routes, `/join` page, full e2e test) per user's request, modeled on Zoom-style disposable meeting links. Fixed a real `pnpm test:server` hang (`--test-force-exit`). UI wiring (Copy-as-Link button, smart paste parsing) left for the follow-up.

**This session:** Finished the UI wiring - "Copy as Link" button, smart paste parsing for a pasted link/token, and `/join` actually completing the join instead of copy-to-clipboard-and-redirect. Along the way, found and fixed two real bugs: `JoinPage.tsx`'s confirm button could stay stuck disabled because it checked the data-loss guard once instead of polling it (matching `DataletSettings.tsx`'s existing pattern), and a broken sentence in the permanent-erasure warning left over from an earlier session's blind text-replace. Extracted the code-redemption branching logic into `src/utils/codeRedemption.ts`, shared by the manual field and `/join` so they can never judge a pasted code or link differently. 143/143 client, 78/78 server, all green.
