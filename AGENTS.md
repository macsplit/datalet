# Localgraph Session Handoff

## Current Status

**Clean.** All suites pass: 161/161 client (Playwright, +1 intentionally skipped), 78/78 server (node --test), 4/4 offline. No known failing tests, no open bugs.

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

### Markdown field type

New field type (`did:ng:z:markdown`), a sibling of `longText` for longer notes with basic formatting - headings, bold/italic, inline code, fenced code blocks, lists, blockquotes, links.

- **`src/utils/markdown.ts`**: `renderMarkdownToSafeHtml(source)`. Hand-rolled, not a dependency (`marked`/`markdown-it` etc. were considered and deliberately skipped - the app has near-zero runtime deps and "safe by construction" was easier to verify in ~150 lines we fully control than to audit in someone else's parser config). Raw HTML in the source is never given a code path that could turn it into a real element: every tag in the output comes from this file's own template strings, and the only things ever interpolated are text run through `escapeHtml` or a URL run through `safeWebUrl`. `<script>` typed into the field can only ever render as the visible text `<script>`.
- **No image support.** `![alt](url)` is not a recognized token - the `!` falls through as literal text and `[alt](url)` becomes an ordinary link, never an `<img>`. Deliberate: an `<img>` fetches its `src` the instant the record renders, with no click required, which is a tracking-pixel vector for a field that can hold someone else's synced or COPY-code data, and it would just be a broken icon offline. Decided explicitly with the user, not an oversight - see "Keep as a link" in the design decisions below.
- **`src/utils/urlSafety.ts`**: `safeWebUrl` extracted here from `FieldWidget.tsx` (was a private, unexported function there) so the markdown renderer and the URL field judge a link's safety the same way - http(s)-only, everything else (including `javascript:`, relative paths, and bare anchors like `#section`) degrades to visible literal text rather than an active link or a silent drop.
- **`src/components/FieldWidget.tsx`**: new branch, monospace `<textarea>` (`.textarea-mono`, `maxLength={MARKDOWN_FIELD_MAX_LENGTH}`) when editing; a `<div className="markdown-body">` (not `<p>` - the rendered markdown contains block elements, invalid nested in a paragraph) via `dangerouslySetInnerHTML` when not - the only use of it in the codebase, made safe by the renderer's construction rather than by a sanitizer pass.
- **Length cap**: `MARKDOWN_FIELD_MAX_LENGTH = 50_000` chars, enforced client-side via the textarea's native `maxlength`. A UX guard, not a security boundary - the real backstops (`MAX_BODY_BYTES` = 2MB per request, `VAULT_QUOTA_BYTES` = 8MB default per vault, both server-side and pre-existing) already make an oversized paste impossible to lose data over; this just keeps the editor and the re-render-on-every-keystroke pleasant. Value chosen by the user over three other options.
- **`src/shapes/shex/metaShapes.shex`**: `markdown` added to `Widget`'s `fieldType` enum; `src/shapes/orm/metaShapes.schema.ts` and `metaShapes.typings.ts` regenerated via `pnpm build:orm`. **`src/pages/BlocksBuilderPage.tsx`**: added to the `FIELD_TYPES` picker.
- **`src/styles/global.css`**: `--font-mono` token extracted (was a literal, duplicated now that a second place needs it - `.datalet-vault-id` updated to use it too), `.textarea-mono`, `.markdown-body` (deliberately plain typography, reusing the app's existing `--color-heading-2`/`--color-heading-3` tokens rather than inventing a markdown-specific palette).
- **A real bug found by the XSS test, fixed**: the bold/italic inline tokenizer originally matched `__[^_]+__` greedily with no word-boundary guard, so two unrelated `__dunder_identifiers__` anywhere in the same note - `window.__pwned` appearing twice, e.g. once in a pasted `<script>` tag and once in a pasted `<img onerror>` attribute, exactly the shape a naive XSS payload takes - would pair up as a single bold span stretching between them, swallowing everything in between. Not an actual security hole (everything inside stays HTML-escaped either way), but wrong, and exactly the kind of thing this field's content (logs, code, identifiers) will contain constantly. Fixed with `(?<!\w)` / `(?!\w)` boundary guards on both underscore alternatives, matching CommonMark's real intraword-underscore rule; asterisk-based emphasis wasn't touched (double-asterisk collisions in plain prose are not a realistic occurrence the way dunder identifiers are).
- **Tests**: `tests/data-blocks.spec.ts`, `noteFixture()` + six new tests - edit/render round trip for every supported construct, the XSS-non-execution test that caught the bug above, unsafe/relative link degradation, image-syntax-becomes-link, the length-cap enforcement (via real keystrokes past a `fill()`-primed near-cap value, since a raw `.value` assignment bypasses the browser's native `maxlength` enforcement and would prove nothing), and the print-view fix below.
- **Print view was a separate bug, found right after landing this**: `BlockRenderer.tsx`'s print sheet has its own independent value-to-text stringifier (`printableValue`) that never went through `FieldWidget.tsx` or the new renderer - a markdown field printed as literal `# Title` / `**bold**` source. Fixed by special-casing `did:ng:z:markdown` at the `<td>` render site to render the same safe HTML the screen shows, with `@media print` overrides so headings stay plain ink instead of carrying the screen's accent colors (matching the print sheet's pre-existing "document, not a screenshot" rule for `h1`).
- **A third fix found right after that**: `.info-grid` (`global.css:606-610`, the grid a record's fields render into) is `repeat(auto-fit, minmax(210px, 1fr))` - a column never actually shrinks below 210px regardless of sibling count (it wraps to fewer per row instead), so the user's original fear of a markdown field getting crushed to 20% width among five fields doesn't literally happen. Still, paragraphs of content read better at full width than in a fixed 210px column, so both `longText` and `markdown` (the two field types that hold prose rather than short scalar values) now get `.field-group-full-width` (`grid-column: 1 / -1`) unconditionally - not just markdown, for consistency between the app's two multi-line field types, which shared this same never-addressed layout quirk before now.

**Design decisions made, in case they need revisiting:**
- Hand-rolled renderer over a dependency (see above).
- No image rendering - links only. User's call, weighed against the tracking-pixel and offline-breakage risk explicitly.
- 50,000-character soft cap, client-side only, chosen by the user from 50k/100k/250k/uncapped.
- No nested inline markup (bold inside a link, etc.) and no CommonMark-complete emphasis flanking rules beyond the underscore word-boundary fix above - "basic format effects," not a full markdown implementation.

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

**Previous session:** Finished the UI wiring - "Copy as Link" button, smart paste parsing for a pasted link/token, and `/join` actually completing the join instead of copy-to-clipboard-and-redirect. Along the way, found and fixed two real bugs: `JoinPage.tsx`'s confirm button could stay stuck disabled because it checked the data-loss guard once instead of polling it (matching `DataletSettings.tsx`'s existing pattern), and a broken sentence in the permanent-erasure warning left over from an earlier session's blind text-replace. Extracted the code-redemption branching logic into `src/utils/codeRedemption.ts`, shared by the manual field and `/join` so they can never judge a pasted code or link differently. Fixed `.layout-row`'s recurring horizontal-overflow-flash bug structurally (`flex-wrap` instead of a per-call-site patch) and backed it with a general no-overflow test suite. Cleared up misleading copy on the datalets join field. Full nuke-and-redeploy of `nuc`'s Docker volumes at the user's request.

**This session:** Assessed and built a new `markdown` field type - a sibling of `longText` for longer notes with basic formatting. Hand-rolled the markdown-to-HTML renderer (`src/utils/markdown.ts`) rather than adding a dependency, safe by construction: every tag in the output comes from the renderer's own template strings, never from unescaped user input. Deliberately no image rendering (tracking-pixel + offline-breakage risk, decided explicitly with the user, links only). 50,000-char client-side length cap (user's choice among three options), layered on top of the pre-existing 2MB request / 8MB vault server-side limits, which already made data loss from an oversized paste impossible before this session started. The XSS test caught a real (non-security) formatting bug along the way - unguarded `__[^_]+__` matching greedily across unrelated dunder identifiers - fixed with word-boundary lookarounds. 161/161 client (+1 skipped), 78/78 server, all green.
