# Plan: Multi-Tenant Hosting and User-Facing Identity

**Status: active.** Track B (B1 through B6) was completed 2026-08-17; Track A
has not started. Written 2026-08-16 from the code as it stood at `b707800` and
kept current as work lands.

Two independent tracks, plannable and shippable separately:

- **Track A — Multi-tenant hosting.** Make one backend deployment carry
  thousands of vaults, each a separate world, rather than the "one person's
  devices" workload the sync tier is currently documented for.
- **Track B — User-facing identity.** Stop showing people `did:ng:…` strings
  and stop making them hand-transfer a 68-character two-field credential.

They share no files. Track B's largest piece (the label resolver) is the
cheapest real win in the repository; Track A's first item is the hardest
ceiling.

## What this plan is not

**Track A is not multi-user.** [`roadmap.md`](roadmap.md) lists accounts,
roles, per-record ownership, audit trails and selective sharing as out of scope
on purpose, and this plan does not touch that. A vault stays all-or-nothing and
single-world; the change is how many *separate* such worlds one deployment can
hold. Every item below is compatible with the vault-token scheme in
`remote-sync-architecture.md` §9 exactly as designed.

**Track B does not change internal identifiers.** `did:ng:z:meta:<kind>:<uuid>`
stays exactly as it is. It is the second half of every `${graph}|${id}` store
key, it is embedded in every patch path across all three patch implementations,
it is the Neo4j `(graph, subjectId)` node identity, and some values are
well-known constants (`did:ng:z:HomeTab`, `did:ng:z:SettingsSingleton`).
Renaming it would be a migration through four systems for no user benefit,
because the user should never see one. The work is a display layer.

Neither track changes patch algebra, so the "change one, change all three"
rule for `localNgEngine.ts` / `patchApply.ts` / `applyBatch.lua` is not
triggered. A4 adds an accept-time *gate* inside `applyBatch.lua`, which is the
one file in that trio it touches, and it changes acceptance, not application.

---

## Track A — Multi-tenant hosting

### A1. Multiplex the materializer's stream consumers  — **blocking, large**

**Problem.** `discoverAndWatch()` (`server/src/materializer.ts:130`) walks
every vault in `vaults:index` and starts `runVaultConsumer()` for each, which
opens `newBlockingConnection()` and loops forever with no teardown. The doc
comment at `materializer.ts:87` claims it mirrors
`server/src/redis/streamWatcher.ts`, but that one stops on its last listener
(`streamWatcher.ts:47`) and this one has no stop condition at all. Cost is one
permanent Redis connection per vault that has *ever existed*, plus one
concurrent `XREADGROUP` loop each. Redis's default `maxclients` is 10,000 and
per-connection memory plus file-descriptor limits bite well before that.

**Change.** `XREADGROUP` accepts many streams in one call, and
`MATERIALIZER_GROUP` is already a single constant, so one connection can carry
a batch of vaults:

```
XREADGROUP GROUP materializer <consumer> COUNT 50 BLOCK 5000
  STREAMS k1 k2 … kN > > … >
```

- Batch vaults into groups of a tunable `MATERIALIZER_STREAMS_PER_CONNECTION`
  (start at 64). Connections become `ceil(vaults / 64)` instead of `vaults`.
- Apply the same batching to the crash-recovery drain (the `"0"` read), not
  just the live tail.
- On discovery, add new vaults to an existing under-full batch; only open a
  new connection when every batch is full.
- Keep `ensureConsumerGroup` per stream — it is `MKSTREAM`-idempotent and cheap.

**Known trade to accept and document.** Entries within one connection are
processed sequentially, so a slow Neo4j write for tenant X delays tenants
sharing its batch. That head-of-line coupling is new (today each vault has its
own connection and blocks only itself). Mitigations: keep `COUNT` small, tune
batch size down if lag appears, and let A2's sharding add parallelism. This is
a deliberate trade of isolation for a ceiling that currently caps the whole
product at low hundreds of tenants.

**Complementary, optional.** Idle teardown — drop a vault from its batch after
N minutes with no entries and re-add on discovery. Only worth doing if the
registered-to-active ratio turns out to be extreme.

### A2. Shard materializer processes; fix the consumer name — **medium**

**Problem.** Every materializer process runs the same discovery over *all*
vaults, so a second process doubles connections instead of halving load. The
consumer group makes concurrent processing *safe* (one entry to one member),
not *sharded*. Separately, `CONSUMER_NAME` defaults to the literal
`"materializer-1"` (`materializer.ts:38`) — two processes started without
distinct `MATERIALIZER_CONSUMER_ID` share a consumer name, which defeats the
per-consumer pending-entry recovery that the stable-name design exists for.

**Change.**

- Add `MATERIALIZER_SHARD_INDEX` and `MATERIALIZER_SHARD_COUNT`. A process
  claims vault V when `fnv1a(V) % SHARD_COUNT === SHARD_INDEX`. Stable hashing
  means no coordination and no rebalancing chatter.
- Derive `CONSUMER_NAME` from the shard index (`materializer-<index>`) so it
  stays stable across restarts — which is the property `materializer.ts:35`
  correctly insists on — while differing between processes.
- Claim a shard in Redis (`materializer:shard:<index>`, short TTL, heartbeat
  refresh) and log loudly on a conflicting claim. This cannot prevent a
  misconfiguration, but it makes one visible instead of silent.
- Document the scale-out procedure in
  [`remote-sync-deployment.md`](remote-sync-deployment.md); the current text
  implies extra processes just work.

This is `remote-sync-architecture.md` §6.3's sharded-worker-pool note, which
stops being optional at this tenant count.

### A3. Bound Neo4j label cardinality — **small**

**Problem.** `sanitizeLabel()` (`server/src/neo4j/materialize.ts:105`) derives
a label from the last segment of the type IRI. User records carry
`did:ng:z:user:<schemaId>` and schema ids are random UUIDs, so **every schema
in every tenant mints a distinct Neo4j label**: 1,000 tenants × 5 schemas =
5,000 labels; 10,000 × 5 = 50,000. That is a well-known Neo4j anti-pattern for
token store and label-index overhead.

**Change.** The label is not load-bearing: the constraint is on
`(:Record {graph, id})` and the index `record_graph_type` is on
`(r.graph, r.type)` — the *property*. So:

- Whitelist the five metadata types to their existing labels (`Type_Tab`,
  `Type_Block`, `Type_Widget`, `Type_SchemaDef`, `Type_PropertyDef`, plus
  `Type_Settings`). These are bounded and shared across all tenants.
- Collapse everything else — i.e. every `did:ng:z:user:*` — to a single
  `Type_User`. The exact type remains in `r.type`, unchanged, so no query
  changes.
- Keep the `[A-Za-z0-9_]` whitelist and the "never splice unwhitelisted text
  into Cypher" comment; the safety property is unaffected and still needed.

**Migration.** Existing deployments hold stale per-schema labels. They are
harmless (extra labels on nodes that also get `Type_User`), so the default is
to stop minting new ones and leave old ones. Ship an *optional* cleanup script
that enumerates `CALL db.labels()`, filters `Type_`-prefixed labels not in the
whitelist, and removes each via the same spliced-whitelist mechanism.

### A4. Per-vault storage quota — **medium**

**Problem.** `MAX_BODY_BYTES` (`server/src/httpServer.ts:30`) caps a single
request at 2 MB; nothing caps a vault's total size. The 4 MB ceiling is a
client-side `RUNTIME_LIMITS` constant that a modified client or a `curl` loop
ignores entirely. With `maxmemory-policy noeviction` — which
[`remote-sync-deployment.md`](remote-sync-deployment.md) correctly requires —
one abusive tenant fills Redis and *every* tenant stops accepting writes.

**Change.** The quota has to be enforced where the accept decision is already
atomic, which is `server/src/redis/applyBatch.lua`:

- Maintain `vault:<id>:bytes` inside the script, adjusted by the byte delta of
  each write (and credited back on removal), so it stays consistent with the
  accept decision under concurrency.
- Reject a batch that would cross `VAULT_QUOTA_BYTES` (default 8 MB — twice the
  client ceiling, leaving headroom for builder metadata) and return a reason.
- Reject **all-or-nothing**, matching `persistNow()`'s two-pass discipline in
  the browser. A half-applied batch at the quota edge would be worse than a
  refusal.

**Client side is already built.** `remoteSyncEngine` handles wholly and
partially rejected batches and surfaces the server's reason in a visible
warning. A quota rejection reuses that path with a new reason string; no new
client mechanism is needed.

### A5. Per-vault write rate limit — **small, with one sharp edge**

**Problem.** Only vault *creation* is limited (`VAULT_CREATE_RATE_LIMIT`,
10/hour, keyed on `X-Forwarded-For`). Nothing limits writes, so one tenant can
saturate ingest, the stream trim, and materialization for everyone.

**Change.** Apply the existing `checkRateLimit()` primitive
(`server/src/redis/rateLimit.ts`) keyed on `vault:<id>:wrate` in the
`POST /sync/patches` path, before the Lua call. Default generously —
600 batches/minute is far above human editing and still bounds abuse.

**The sharp edge.** Today the client treats both a 409 and a partially accepted
200 as *terminal* — correctly, because under last-write-wins a rejection is
final and the winning value arrives over SSE. A rate-limit refusal is the
opposite: the write is still valid and **must be retried**. `remoteSyncEngine`
therefore needs an explicit 429 branch that keeps the batch in the outbox and
backs off, distinct from the terminal branches. Getting this wrong loses
writes silently, which makes it the highest-risk item in Track A despite being
the smallest.

### A6. Vault lifecycle — **medium**

**Problem.** There is no delete, no last-active tracking, and no reclamation.
`vaults:index` only grows, and until A1 lands every abandoned vault costs a
permanent connection forever.

**Change.**

- `DELETE /sync/vaults?vault=<id>`, bearer-authenticated with the current
  token: remove every `vault:<id>:*` key, drop index membership, delete the
  Neo4j `:Record` and `:VaultMeta` nodes, and disconnect attached SSE
  listeners.
- Record `lastActiveAt` in the vault meta hash on accepted writes (cheap: it is
  already an `HSET` path).
- Extend the materializer's existing tombstone sweep to also report vaults idle
  beyond a configurable window. Report only — automatic deletion of a user's
  data on an inactivity timer is a policy decision for whoever deploys this,
  not a default.

### A7. Per-tenant observability — **small**

Multi-tenant operation needs per-vault numbers that do not exist today: record
count, byte usage against quota, accepted-writes rate, materialization lag,
last-active. Expose them behind a separate admin credential (never the vault
token) at `GET /sync/admin/vaults`, and emit the same values as structured
logs. Without this, A4's quota and A5's limit are unobservable until a tenant
complains.

---

## Track B — User-facing identity

### B1. Schema label property and a store-level resolver — **completed 2026-08-16**

**Problem.** Reference values render as raw `did:ng:…` in four places: the sort
comparator, the reader search haystack, per-block JSON export, and the print
table. `docs/architecture.md` §5 names this, and `BlockRenderer.tsx:158`
explains why — resolving a label needs the target schema's subscription, and
opening a second subscription per data block was deliberately avoided.

**Change.**

- Add an optional `labelPropertyId` to `SchemaDef`. This means editing
  `src/shapes/shex/metaShapes.shex`, re-running `pnpm build:orm`, and
  committing the regenerated `src/shapes/orm/*` — the repo requires this and
  the verification gate below enforces it.
- Default it to the heuristic already implemented at
  `src/components/FieldWidget.tsx:99` (first text-or-enum property), so nothing
  changes for existing schemas and no data migration is needed.
- Surface it in the schema editor as a "Show records as" selector.
- Add `lookupRecordLabel(graph, id)` to `localNgEngine`, reading the in-memory
  store **directly**. No ORM subscription is involved: the whole store is
  already resident — that is the defining constraint of the design. Explicit
  selections are O(1) map hits; the automatic legacy heuristic is scanned once
  and cached per schema.

**Trade to state in the code comment.** A label edited in a different block
will not restyle this one until it re-renders. For a sort key, a search
haystack, and two point-in-time outputs that staleness is acceptable. The
editing control keeps the live subscription it already has, because it needs
reactivity.

**Landed detail.** The existing live reference editor also honours
`labelPropertyId`, so editing and the four non-reactive reader paths cannot
disagree. Deleting the selected property, or changing it away from text/enum,
returns the schema to automatic selection.

### B2. Use the resolver at the four leak sites — **completed 2026-08-16**

One resolver, four call sites in `src/components/BlockRenderer.tsx`: the sort
comparator, the search haystack, `exportRecords()` (`:243`), and the print
columns. Export keeps `@id` — the comment at `:250` about a silent data-loss
trap is right, and it is the only stable rejoin key — but leads the row with
the resolved `@label`. Reference-valued export fields carry both `@label` and
`@id` (or arrays of those pairs), preserving readability without discarding
the stable relationship key.

### B3. One pairing field instead of two — **completed 2026-08-16**

**Problem.** `SyncSettings.tsx:138` shows a 36-character UUID *and* a
32-character base64url token as two separate fields, both mandatory, both
opaque. The UUID is not a secret but looks like one, so people guard the wrong
value and occasionally paste them into swapped boxes. base64url is
case-sensitive and contains visually ambiguous characters. A transposed
character yields a 401 that cannot distinguish a bad id from a bad token.

**Change.** Fold both values into a single self-describing string in Crockford
base32 with a trailing check symbol:

```
LG1-K3RM9-T7AVX-…
```

Crockford base32 drops `I`, `L`, `O` and `U`, decodes case-insensitively, and
maps `0/O` and `1/I/L` onto each other, so a code read off a screen survives.
The `LG1` prefix makes the string self-identifying and versionable. The check
symbol lets the UI say "that code has a typo" instead of returning a 401.

**The arithmetic, stated up front:** 16 bytes of vault id plus 24 bytes of
token is 320 bits ≈ 64 characters in any human-safe alphabet. A durable secret
cannot be short. This field is therefore designed to be *copied*, and B4 and
B5 handle the cases where a human would otherwise type it.

**Notable property: no server change.** Encoding and decoding happen entirely
in the client, which decodes to the same `vaultId` + `vaultToken` the API
already expects. The join form must also still accept the legacy two-field
input so existing pairings keep working.

**Landed detail.** The 320-bit payload is 64 Crockford characters followed by
the standard mod-37 check symbol, grouped as thirteen five-character groups
after `LG1`. The primary create/join/rotate UI uses that single code; the old
two fields remain in a collapsed legacy fallback. The full-stack smoke now
pairs its second real browser through the LG1 code.

### B4. QR pairing — **completed 2026-08-16**

`remote-sync-architecture.md` §9 already says the token is shown "to copy/scan
onto each additional device". Only the copy half was built. In the common case
both devices are on the same desk.

- Display: render B3's string as a QR. Encode-only QR is small enough to write
  in-repo with no dependency, which keeps the "no external services" property
  the diagrams already honour.
- Scan: use `BarcodeDetector` where available, falling back to the text field.

**Constraint to document, not solve.** `getUserMedia` requires a secure
context, and this app is explicitly expected to run on plain-HTTP LAN origins —
see the comment in `src/utils/randomId.ts`. So *displaying* a QR works
everywhere; *scanning* one works only over HTTPS or on localhost. The manual
field must therefore stay, and the UI should say why scanning is unavailable
rather than hiding the control.

**Landed detail.** The connected-vault view renders the exact `LG1` value as
a dependency-free Version 4-L QR SVG. The join view offers camera scanning
only in a secure context when `BarcodeDetector` and `getUserMedia` are both
available; otherwise it explains the HTTPS/localhost constraint and leaves the
manual pairing field visible. The QR test independently reads the matrix,
validates all Reed-Solomon syndromes, and reconstructs the original code.

### B5. Short-lived pairing exchange code — **completed 2026-08-16**

For devices that are not in the same room, make the typed thing disposable
instead of durable:

- `POST /sync/pair-code`, bearer-authenticated → `{ code, expiresAt }`.
- `POST /sync/pair-redeem` `{ code }` → `{ vaultId, vaultToken }`.
- Store as `vault:pair-code:<hash>` with a 10-minute TTL, redeemed exactly once
  (atomically, via `GETDEL` or a small script).
- Code format: 8 Crockford base32 characters (40 bits) plus a check symbol —
  `PAIR-K3RM-9T7A-X` — short enough to read over a phone call. (The original
  eight-character example omitted the ninth check character.)

**This is machinery that already exists.** `vault:<id>:stream-ticket:<hash>`
is the same pattern — a short-lived, single-purpose credential bound to the
current token generation — pointed at a different purpose.

**Security note.** Redemption hands over the durable token, so it is a more
valuable guessing target than a stream ticket. Rate-limit redemption hard per
IP with `checkRateLimit`, and invalidate outstanding codes on token rotation,
exactly as stream tickets already are.

**Landed detail.** A connected device explicitly creates the temporary code;
the ordinary join field accepts either `LG1` or `PAIR`. Redis stores the
credentials under a SHA-256 hash of the code for ten minutes. A Lua redemption
deletes the entry and compares its token-generation hash atomically, so it is
single-use and rotation-safe. Redemption defaults to ten attempts per IP per
minute. The live two-browser smoke pairs its second browser through this
exchange rather than transferring the durable token directly.

### B6. Readable tab URLs — **completed 2026-08-17**

`/tab/$tabId` (`src/router.tsx:120`) produces roughly 80 characters of
percent-escaped `did:ng:…`. Accept either a slug or a raw id: derive the slug
from the tab name at render time and resolve it against the tab list
`MetaStoreContext` already holds in full. On a collision, the first tab by
order keeps the slug and the others fall back to their id. Raw-id URLs keep
working forever, so existing bookmarks do not break.

Deriving rather than storing avoids a `metaShapes.shex` change and avoids two
devices independently creating conflicting slugs offline.

**Landed detail.** `tabRoutes.ts` derives normalized slugs from the live,
already ordered user-tab list. The first tab owns a colliding slug; later
tabs, empty slugs, and slugs shadowing another raw id use their permanent id.
Resolution checks every raw id before considering slugs, preserving old
bookmarks. Renaming or reordering may change the preferred generated URL, but
the raw-id form remains permanent and unknown segments use the existing
not-found view.

---

## Ordering

**Track A.** A1 first — it is the ceiling everything else is measured against,
and A2 builds directly on its batching. A3 is independent and small enough to
land any time. A4 before A5 (a quota without a rate limit is porous; a rate
limit without a quota still lets a slow tenant fill the disk). A6 and A7 last,
but A7 should not slip far: A4 and A5 are unobservable without it.

**Track B.** B1 → B2 is one coherent change and is the best first move in the
whole plan: smallest diff, closes a real papercut, no server involvement. B3
next (client-only, no server change). B4 and B5 are alternatives serving
different situations — build B4 first if users are typically co-located, B5
first if not. B6 whenever.

The tracks share no files and can proceed in parallel.

---

## Testing strategy

The repo already has two harnesses and both should be extended rather than
replaced: Playwright (`tests/`) for browser workflows, and Node's test runner
(`server/test/`) for patch algebra and live Redis/Neo4j. `fullStackSmoke.ts`
covers browser → Redis → Neo4j → second browser. Exactly one new harness is
needed.

### New harness: `server/test/multiTenant.ts`

The whole of Track A is about behaviour that only appears at tenant count, and
nothing currently exercises more than one vault. This harness creates N vaults
(parameterised, default 200), writes to a configurable active subset, and
asserts on:

- **Connection count** via `INFO clients` / `CLIENT LIST` — the A1 regression
  test. Connections must stay roughly flat as N goes 10 → 200; today the
  relationship is linear, so this test fails before the fix and passes after,
  which is the property that makes it worth writing.
- **Per-vault correctness under load** — for every vault, accepted writes equal
  materialized records. This is the check the curtailed endurance run never
  reached.
- **Materialization lag** as a distribution, not a mean, so A1's head-of-line
  coupling shows up as tail latency rather than hiding in an average.
- **Redis memory** against vault count, to validate the sizing claim.

### Per item

| Item | Tests |
| --- | --- |
| **A1** | Flat connection count across vault counts (above). Every vault still materializes. A vault created *after* startup joins an existing batch within the discovery interval. Kill the materializer mid-batch; assert the multiplexed `"0"` drain recovers every pending entry across all streams in the batch, not just the first. |
| **A2** | Two processes with distinct shard indexes cover disjoint vault sets, together covering all of them, with no entry materialized twice. Kill one; assert its pending entries are recovered under the same consumer name after restart. Assert a duplicate shard claim is logged. |
| **A3** | Unit test on `sanitizeLabel` — metadata types keep their labels, `did:ng:z:user:*` collapses to `Type_User`, the `[A-Za-z0-9_]` whitelist still strips hostile input. Integration: 50 schemas across 10 vaults, assert `CALL db.labels()` stays bounded and reads still return correct records via `r.type`. |
| **A4** | Extend `server/test/redisSync.test.ts`. Writes under quota unaffected; the batch that crosses it is refused **whole**, with nothing partially applied; the byte counter is credited back on record removal; the refusal reason reaches the client's existing discarded-writes warning (Playwright, alongside `sync-warnings.spec.ts`). Concurrency: two simultaneous batches that individually fit but jointly exceed — exactly one is accepted. |
| **A5** | Server: a 429 is returned past the limit. **Client (the critical one):** a 429 leaves the batch in the outbox, backs off, and eventually delivers it — asserted by final record state, not by response codes. Add an explicit regression asserting a 429 is *not* treated like the terminal 409 path, since that failure mode loses data silently. |
| **A6** | Delete removes every `vault:<id>:*` key, index membership, and both Neo4j node kinds; an attached SSE client is disconnected; a subsequent request with the old token 401s. `lastActiveAt` advances on accepted writes only. |
| **A7** | Reported per-vault numbers match independently computed ones. The admin endpoint rejects a vault token — it must not be reachable with tenant credentials. |
| **B1/B2** | Playwright in `tests/data-blocks.spec.ts`: a reference column sorts by label rather than id; reader search matches label text; exported JSON carries the label and still carries `@id`; the print table shows labels. Fallback: a target schema with no text or enum property still renders the id without crashing. Unit: `lookupRecordLabel` on a missing target returns the id. |
| **B3** | Pure-function property tests — encode/decode round-trip; the check symbol catches every single-character substitution and adjacent transposition; `0/O` and `1/I/L` decode identically; case-insensitivity; a legacy two-field entry still pairs. This is the cheapest high-value test surface in the plan. |
| **B4** | QR encode → decode round-trip as a unit test. Playwright asserts the QR renders and that the manual field remains present and usable. Camera capture is a documented manual test — it cannot run in the plain-HTTP contexts CI uses, which is itself the constraint worth recording. |
| **B5** | Expired code rejected; a code redeems exactly once and the second attempt fails; redemption is rate-limited per IP; token rotation invalidates outstanding codes; a redeemed pair actually syncs end to end — extend `fullStackSmoke.ts` to pair its second browser context via a code rather than a pasted token. |
| **B6** | A slug resolves to the right tab; a raw-id URL still resolves; a colliding slug falls back to the id; an unknown slug produces the not-found path rather than an error boundary. |

### Endurance

The one open item in [`roadmap.md`](roadmap.md) — a real multi-hour run to
replace the curtailed 19-minute artifact — should be **re-scoped to
multi-tenant** once A1 and A2 land. A long single-vault run answers a question
this plan makes obsolete; the same hours spent across a few hundred vaults
answer both the original memory-leak question and the new connection-and-lag
questions at once. The terminal accepted-versus-materialized equality check
that the curtailed run never reached becomes a per-vault check.

### Gate

Every change ends green on the existing gate, unchanged:

```bash
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec tsc --noEmit -p server/tsconfig.json
pnpm build
pnpm build:server
pnpm test:client
pnpm test:server
```

B1 additionally requires `pnpm build:orm` with the regenerated
`src/shapes/orm/*` committed. Track A additionally requires `./run.sh` plus
`pnpm test:smoke:sync` against real Redis and Neo4j, with `.env.local` loaded
so no integration test is skipped.

---

## Risk summary

| Risk | Where | Mitigation |
| --- | --- | --- |
| Silent write loss | A5's 429 handling in `remoteSyncEngine` | Explicit non-terminal branch; regression test asserting final state, not status codes |
| Cross-tenant latency coupling | A1's shared connections | Small `COUNT`, tunable batch size, A2 sharding, lag measured as a distribution |
| Half-applied batch at the quota edge | A4 in `applyBatch.lua` | All-or-nothing refusal, mirroring `persistNow()`'s two-pass discipline |
| Duplicate shard configuration | A2 | Redis shard claim with heartbeat; loud log; documented procedure |
| Stale Neo4j labels after A3 | Existing deployments | Harmless by design; optional cleanup script |
| Pairing-code brute force | B5 | 40 bits + 10-minute TTL + single use + per-IP rate limit + rotation invalidation |
| Label staleness across blocks | B1 | Documented and accepted for sort/search/export/print; editing control keeps its subscription |

## Effect on existing documents

When items land: update [`product-assessment.md`](product-assessment.md) —
its "ceremony-to-workload ratio" criticism is contingent on the product being
one person's devices and inverts if multi-tenant hosting becomes a supported
mode; update `architecture.md` §5's statement that references sort and search
on raw ids (B2 changes it); update `remote-sync-architecture.md` §6.3, whose
sharded-worker-pool note A2 implements; and update
[`remote-sync-deployment.md`](remote-sync-deployment.md) with the sharding
procedure, the quota and rate-limit variables, and multi-tenant sizing.
