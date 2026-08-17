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

### Theme in the graph

[`theme-in-graph-plan.md`](theme-in-graph-plan.md) proposes moving the visual
theme into the graph, so the last hardcoded part of the app definition becomes
a record like everything else. Cheap because `global.css` is already 228 CSS
custom properties, and small enough (well under 1 KB) that the file-and-image
reasoning does not apply.

T1 through T5 are complete: the project's first Content Security Policy, an
allowlisted set of sixteen colour roles with a closed value grammar, per-role
light and dark fields on the Settings record, and a generated stylesheet rather
than inline custom properties. Only the vendored fonts (T6) remain, and they
are the most optional part.

Two things it rules out on purpose, so they are not later mistaken for
oversights: **webfont URLs in the graph**, because JSON import is a supported
path and a stored URL would make importing someone's backup silently fetch from
their server, ending the "no network code on any path" property unpaired mode
currently has honestly; and **font bytes in the graph**, which stay deferred
under the existing file-and-image decision below rather than being decided
separately.

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
  record behaviour.** References stay one-directional. They now *display* as
  the target's label everywhere rather than as a raw id, but that is a lookup
  of one record by its own id, not a relational feature: nothing traverses the
  reverse direction, aggregates across it, or constrains it.
- **The upstream `@ng-org/orm` subscription-lifecycle race.** Worked around in
  `graph_orm_update`; not fixable here without forking the dependency.

---

## Delivered

### Multi-tenancy and identity tracks

[`multi-tenancy-and-identity-plan.md`](multi-tenancy-and-identity-plan.md)
planned two pieces of work identified after this roadmap was written. Both are
now complete; the plan keeps the per-item detail and the deviations from it:

- **Multi-tenant hosting** — carrying thousands of separate vaults on one
  backend deployment. This is *not* the multi-user work listed as out of scope
  above: a vault stays all-or-nothing and single-world, and the vault-token
  scheme is unchanged. A1 through A7 are complete: the materializer multiplexes
  64 vault streams per blocking connection, deterministically shards vaults
  across leased worker indexes, and keeps Neo4j record labels bounded across
  user schemas, while Redis atomically enforces per-vault storage and write
  limits, authenticated lifecycle deletion cleans both stores, idle vaults are
  reported without automatic reclamation, and per-vault numbers are served to
  an operator-only endpoint and emitted as structured logs.
- **User-facing identity** — resolving `did:ng:` ids to labels in the four
  places they leak (reference sort, reader search, export, print), and
  replacing the two-field pairing credential with one checksummed string plus
  QR and short-lived pairing codes. **Track B is complete:** labels cover all
  four reader surfaces, durable and one-use pairing flows are implemented,
  and user tabs use readable derived URLs while permanent raw-id bookmarks
  continue to resolve.

The endurance run under **Open** should now be re-scoped to multi-tenant:
`pnpm test:multi-tenant` already measures connection count, per-vault
accepted-versus-materialized equality and lag percentiles across 200 vaults in
one pass, and a multi-hour version of that answers the original memory-leak
question at the same time.


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
terminal, then stop the stack with Ctrl-C rather than killing its children (see
the README's note on orphaned servers). The smoke must traverse two browser
contexts, Redis, the materializer and a Neo4j-backed snapshot, and must clean up
its temporary vault.

`pnpm test:server` loads `.env.local` itself, so integration tests run rather
than skip. Check the `# skipped` count anyway: a skip reports as `ok … # SKIP`,
so a suite that reaches neither Redis nor Neo4j still exits green.

Update [`product-assessment.md`](product-assessment.md) as each piece lands.
Its value is that it stays accurate about what is missing.
