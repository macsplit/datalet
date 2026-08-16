# Roadmap

**Status: current.** What is left, what was deliberately deferred, and what is
out of scope on purpose. Replaces `product-gaps-plan.md`, which had become a
long list of finished work; that work is summarised in one table below and the
detail lives in [`build-history.md`](build-history.md).

The gaps this responded to were identified in
[`product-assessment.md`](product-assessment.md), which is kept accurate as
work lands.

---

## Open

### Multi-hour endurance run

The only outstanding verification item. The existing artifact,
[`remote-sync-endurance-results.json`](remote-sync-endurance-results.json), is
honestly labelled `status: curtailed` after roughly 19 minutes of a planned two
hours. Because it stopped early it never ran the terminal
accepted-versus-materialized equality check, and a slow memory leak cannot be
ruled out from a run that short.

This needs a deployment-focused session with real hours available. It gates
nothing else.

### Multi-tenancy and identity tracks

[`multi-tenancy-and-identity-plan.md`](multi-tenancy-and-identity-plan.md)
plans two pieces of work identified after this roadmap was written:

- **Multi-tenant hosting** — carrying thousands of separate vaults on one
  backend deployment. This is *not* the multi-user work listed as out of scope
  below: a vault stays all-or-nothing and single-world, and the vault-token
  scheme is unchanged. The blockers are concrete (the materializer opens a
  permanent Redis connection per vault; Neo4j mints a label per schema per
  tenant; there is no per-vault quota or write rate limit).
- **User-facing identity** — resolving `did:ng:` ids to labels in the four
  places they leak (reference sort, reader search, export, print), and
  replacing the two-field pairing credential with one checksummed string plus
  QR and short-lived pairing codes. The label resolver, its four reader
  integrations, the single checksummed pairing field, and QR display/scanning
  are complete; short-lived pairing codes remain open.

Both include a testing strategy. The endurance run above should be re-scoped
to multi-tenant once the first two items of that plan land.

---

## Deferred by decision

### File and image fields

**Decided 2026-08-14: deferred until a storage design exists.** Not "not yet
got to" — deliberately not built.

File and image values collide head-on with the architecture: the whole store
lives in memory under a 4 MB cap, and every patch value crosses the sync path
as JSON. One photograph exhausts an entire vault.

Three options were weighed:

1. **Defer** until an IndexedDB or blob-endpoint design exists that defines
   quotas, offline behaviour, sync, retention and orphan cleanup. **Selected** —
   consistent with the earlier explicit rejection of an IndexedDB migration.
2. **Small inline images only** — a hard per-value limit around 64 KB, base64
   data URI, client-side downscale on selection, explicit refusal above the
   limit. Ships inside the current architecture and is genuinely useful for
   avatars, icons and thumbnails; useless for documents or photographs, and the
   UI would have to say so rather than let users discover it at the cap.
3. **Blob storage in the sync tier** — an upload endpoint with retention,
   orphan tombstones and quotas. The largest scope, and it breaks the unpaired
   product's "no network surface at all" property, which is one of the few
   things this project can claim honestly.

Revisit option 2 if avatars or thumbnails become the actual ask; revisit option
3 only alongside a decision to change what local-only mode means.

---

## Out of scope, on purpose

None of these can be fixed without changing what the product is. They are
listed so they are not mistaken for oversights.

- **Multi-user accounts, roles, per-record ownership, audit trail, selective
  sharing.** A vault token is all-or-nothing by design.
- **End-to-end encryption, or encryption at rest** in the sync tier.
- **Synchronous durability.** The ~1 s Redis AOF `everysec` crash window stays.
- **IndexedDB or windowed subscriptions.** Considered and rejected in an
  earlier tranche. The 4 MB cap and the full-store startup load remain, and
  everything built since has been sized to live under them.
- **Joins, reverse lookups, rollups, relationship constraints, cascading
  record behaviour.** References are one-directional and unresolved outside the
  on-screen control.
- **The upstream `@ng-org/orm` subscription-lifecycle race.** Worked around in
  `graph_orm_update`; not fixable here without forking the dependency.

---

## Delivered

| Area | What landed |
| --- | --- |
| Reader tools | Per-block search across displayed fields, pagination, configured filter and sort |
| Field types | Date and date-time, URL, email, long text, record references, enum, currency display |
| Data utilities | Per-block JSON export and black-and-white print; whole-graph backup export/import |
| Offline | Web manifest and service worker; cold start offline after one online load |
| Sync UX | Visible warning for discarded writes with count and reason; in-place stale-cursor recovery with no reload; debounced connection-lost banner |
| Editing | Bounded local undo stack, one entry per editing gesture, `Ctrl/Cmd+Z` |
| Interface | Icon controls for the fixed navigation destinations, undo and banner reload |
| Persistence | Incremental per-record `localStorage` writes with a verified migration |
| Coverage | Playwright suites for persistence, bootstrap, data blocks, builders, sync recovery and offline; Node suites for patch algebra and live Redis/Neo4j; both in CI |
| Sync tier | Everything in [`build-history.md`](build-history.md) |

---

## Verification

Any change should end green on all of these:

```bash
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec tsc --noEmit -p server/tsconfig.json
pnpm build
pnpm build:server
pnpm test:client
pnpm test:server
```

Changing `src/shapes/shex/metaShapes.shex` additionally requires re-running
`pnpm build:orm` and committing the regenerated `src/shapes/orm/*`.

Before signing off a tranche, also exercise the real sync path with Redis and
Neo4j running: start `./run.sh`, then run `pnpm test:smoke:sync` in another
terminal. Run the server suite with `.env.local` loaded so no integration test
is skipped. The smoke must traverse two browser contexts, Redis, the
materializer and a Neo4j-backed snapshot, and must clean up its temporary vault.

Update [`product-assessment.md`](product-assessment.md) as each piece lands.
Its value is that it stays accurate about what is missing.
