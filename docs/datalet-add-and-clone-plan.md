# Plan: Gaining a Datalet — Adding, Joining and Cloning

**Status: complete.** A1 to A4 landed. The backup route was **declined**, and A5 landed in a reduced form. See both below. Written 2026-08-21 from the code as it
stands at `65e3be4`, and depends on
[`multiple-datalets-plan.md`](multiple-datalets-plan.md), whose registry,
switcher and eviction rules already exist.

The switcher works but nothing creates a second datalet. This plans the ways
one is gained, and the way one is given away.

## The frame: four routes, one destination

Every way of gaining a datalet ends in the same place — **a vault, paired,
added to the registry, switched to**. They differ only in where the new vault's
contents come from:

| Route | Contents |
| --- | --- |
| Start empty | bootstrap defaults |
| Join a vault | whatever is already in it |
| Redeem a clone code | a copy of someone's graph |
| Restore a backup file | a copy of your own export |

Three of the four are *create vault → populate → add entry → switch*, and
"populate" already exists: `importGraphBackup` remaps graph-qualified keys and
each record's `@graph`, which is exactly what adopting someone else's graph
needs. This is one flow with a source step, not four features.

## What this corrects on the way past

Creating a vault and joining one both land in `setVaultConfig` today, and both
*replace* the active graph. Under datalets they are plainly different acts:

- **Create vault** converts *this* datalet from local-only to paired. Its
  records go up; the registry entry keeps its id. Not an add.
- **Join vault** adopts *another* datalet onto this device. It must **add an
  entry**, not replace what you are working on — today it silently abandons the
  local graph.

Which leaves the pair users will confuse, and the wording has to carry it:

> **Join** — the same datalet, now also here. One vault, two devices, edits
> converge.
> **Clone** — a new datalet that began as a copy. Two vaults, independent from
> that moment.

## What this is not

**Not a partial clone.** A clone is the whole graph: records, schemas, tabs,
blocks, widgets, theme. A copy of only the structure is an export with extra
steps, and deciding which half is the "essence" produces modes nobody can
predict.

**Not a relationship.** No backlink, no update push, no list of who cloned you.
A clone is a copy that stops being your business the moment it is taken — which
is also all a system that keeps no history could honestly offer.

**Not frozen.** Redemption reads the current snapshot, which already exists, so
live costs nothing. Frozen stays expressible later as "publishing clones once
into a hidden vault", using the same primitive, if it ever earns its place.

**Not encrypted, and said so.** See A4 below; the plan is to state it rather
than to soften it.

**Not a one-step datalet from a backup file — declined.** Three shapes were
weighed and all cost more than they return. Uploading the backup to a
populating endpoint fails on `MAX_BODY_BYTES`, which is 2 MB against a backup
of up to 4.5M characters, and raising a global guard for one route is the wrong
trade. Applying it after the adopting reload means stashing the whole backup in
localStorage across that reload, transiently doubling the very footprint the
one-resident rule exists to bound. Writing it locally and letting sync push it
up leaves the new vault empty server-side until the upload finishes, which is
the fault the clone route was reversed to avoid.

Meanwhile the outcome is already reachable in two steps with no new code: add
an empty datalet, then **Import backup**, which fills whichever datalet is
open. The panel now says so. This is one click saved against three bad
mechanisms, so it is a decision rather than a gap.

---

## A1. Add a datalet — **completed 2026-08-21, less the backup route**

One control in the Datalets panel, with a source step: start empty, or paste a
code, or choose a backup file. The code field routes on prefix, as the join
field already does — `LG1-` a durable credential, `PAIR-` a one-use handoff,
`COPY-` a clone. One box, three meanings, and the app knows which it was given.

**The prerequisite has to be explained, not just enforced.** More than one
datalet requires each to be paired, because only the active one is resident and
an unpaired one has no second copy. So adding a second while the current one is
local-only must offer to pair the current one first. `canLeaveActiveDatalet()`
already refuses; the add flow needs to say *why* rather than only *no*.

**Join changes from replace to add.** The entry is appended and switched to,
through the same restore-before-evict path a switch already uses, so the datalet
being left is evicted only after the new one is in hand.

## A2. The adoption size check — **completed 2026-08-21**

Before a fetched graph is adopted, measure it against this browser's budget and
refuse if it does not fit — with a message naming both numbers.

This is the only place the question can be answered, because it is the only
place both numbers are known. It covers joining, redeeming a clone and
restoring a backup with one guard.

**Landed detail.** Writing it exposed an ordering fault in the switch. Restore
was applying the incoming graph and flushing *before* evicting the one being
left, which put both graphs in localStorage at once - the state the
one-resident rule exists to prevent, and enough on its own to trip the cap on a
switch that would otherwise fit. Fetching is now separate from applying:
`fetchVaultSnapshot` returns the records, the size is checked, the old graph is
evicted, and only then is the new one written. "Restore before evict" still
holds in the sense that matters, since the records are in hand before anything
is discarded.

**Why not fix it by making the caps match.** The server quota and the client
cap do different jobs — one bounds an abusive tenant, the other keeps a store
loadable — and they do not even share a unit. The server counts UTF-8 bytes
(`#raw` in `applyBatch.lua`, over `cjson.encode` output); the browser counts
UTF-16 code units (`String.length`). They agree on ASCII and diverge sharply
otherwise: `日本語` is 3 units and 9 bytes, `🙂` is 2 and 4. Setting both to the
same number would cut a CJK user off at roughly a third of what an English user
gets for the same app.

So: leave the server quota as the abuse ceiling it is, **stop describing it in
`redis/config.ts` as "twice the browser's ceiling"** — that framing invites a
later tidy-up into parity — and record the encoding difference where someone
would look before attempting one.

## A3. Publish a clone code — **completed 2026-08-22**

From the active datalet: produce a `COPY-…` code that redeems into a complete
copy of its graph.

- **Server-side**, `vault:clone-code:<hash>` beside the existing
  `vault:pair-code:<hash>`, reusing the Crockford encoding and check symbol from
  `pairCode.ts` with a distinct prefix.
- **Long-lived and multi-use**, unlike a pair code, because it hands over a copy
  rather than a credential. Which makes the next item load-bearing rather than
  polish.
- **Redemption returns records, not credentials**: `POST /sync/clone-fetch`
  *(planned, never built — see the reversal below; the endpoint that exists is
  `POST /sync/clone`)* answers with the source's snapshot and never issues a vault token for it. The
  recipient then runs A1's ordinary create-and-populate path. The source's
  all-or-nothing token is untouched, so that documented property survives: the
  code is a capability to *copy*, which is neither read nor write access in the
  ongoing sense.
- Rate-limited per IP on redemption, as pair-code redemption already is.

**Reversed on implementation: the copy is made server-side after all.** The
plan had redemption return records for the recipient to upload into a vault of
their own. That path leaves the new vault empty on the server until the upload
finishes, so a failure part-way produces a datalet that is complete locally and
partial remotely — and the next time it was opened, the restore would hand back
the partial copy. `POST /sync/clone` therefore creates the vault and fills it
before returning credentials, and the client then joins it through the path
that already existed. Less client machinery, not more.

**A second correction, found by a failing test.** The copy first read through
`snapshot()`, which reads the Neo4j mirror. That mirror trails accepted writes
by seconds under load and indefinitely if the materializer is stopped, so a
clone could quietly hand over a stale or empty datalet. It now reads the
accepted state from Redis. The copy is still written through `applyBatch`
rather than straight into Redis, because a direct write would never reach the
stream, and so never reach Neo4j — a clone that looked complete and came back
empty the first time anyone opened it.

## A4. Revocation, and saying what a code does — **completed 2026-08-22**

A code you cannot see is a code you cannot revoke, so the list and the revoke
are part of publishing, not a follow-up.

- A list of live codes for the active datalet, each revocable.
- Revoking deletes the Redis key, so subsequent redemptions fail.

And the confirmation at publish time states three separate facts, plainly,
because all three are true whether or not they are said:

1. This hands over **everything** in this datalet — every record, not only its
   design.
2. The sync server can read it. There is no end-to-end encryption; that is what
   this product is, not a gap in it.
3. Revoking stops **future** copies. It does nothing about copies already taken.

## A5. Provenance — **landed reduced, 2026-08-22**

The `seq` stamp was **declined**: it answers "which revision" for a system that
keeps no revisions, and nobody reads it.

What landed instead answers a question that actually arises. A copy is created
carrying the source's own `Settings.appTitle`, so a list holding both shows two
identically named entries with nothing to tell them apart. A registry entry
made by copying now records **when**, and the list shows it. A datalet joined
from an `LG1` code is deliberately not marked, since it is the same datalet
rather than a copy - and a test pins that distinction, because join and copy
looking alike is the confusion this whole plan is built around avoiding.

---

## Ordering

A1 with A2 — the add flow is independently useful, and the size check is part
of adopting a graph rather than a separate feature. Then A3 and A4 together;
publishing without revocation is not a thing that should exist. A5 whenever, or
never.

## Testing strategy

| Item | Tests |
| --- | --- |
| **A1** | Playwright: starting empty adds an entry and switches to it; joining a vault **adds** rather than replacing, and the datalet left behind is still listed; adding while local-only offers to pair first and says why; the code field routes `LG1-`, `PAIR-` and `COPY-` to their three different outcomes from one input. |
| **A2** | Unit: a graph larger than the local budget is refused, and the refusal names both figures. Playwright: the same refusal on each of the three adoption routes, asserting that nothing was created — no vault, no registry entry — because a check that fires after creating a vault has not helped. Plus a non-ASCII case pinning that the client measures code units, so a later "make the caps match" cannot pass unnoticed. |
| **A3** | Server: a code redeems to a snapshot and never to a credential; the source's token is unchanged afterwards; redemption is rate-limited per IP; a malformed or unknown code is refused. Playwright: a clone lands as a *new* datalet, the original is untouched, and editing the clone does not reach the source's vault — the property that distinguishes a clone from a join, asserted rather than assumed. |
| **A4** | Server: a revoked code stops redeeming; revocation is scoped to one code and leaves others working. Playwright: publishing shows the code in the live list; revoking removes it; the confirmation names all three facts, because wording that quietly drops the encryption sentence is the regression that matters here. |

## Risk summary

| Risk | Where | Mitigation |
| --- | --- | --- |
| Someone publishes their records without realising | A3/A4 | Confirmation naming all three facts; whole-graph is stated, not implied |
| A code cannot be withdrawn | A4 | List and revoke ship with publishing |
| A clone is adopted that the browser cannot hold | A2 | Checked before anything is created, not after |
| The two caps get "tidied" into parity | A2 | Encoding difference documented at both sites, and a test pinning the client's unit |
| Join silently destroys the current datalet | A1 | Join adds; eviction only through the restore-first switch path |
| Clone mistaken for shared access | A1 | Join and clone named and described as opposites |

## Effect on existing documents

- `architecture.md` — the ways a datalet is gained, and the adoption check.
- `remote-sync.md` — `POST /sync/clone`, the clone-code key, revocation.
- `remote-sync-architecture.md` §9 — a third credential kind, narrower than a
  vault token: the capability to copy.
- `redis/config.ts` — the quota comment, per A2.
- [`product-assessment.md`](product-assessment.md) — "no selective sharing"
  becomes "sharing by copy, never by access", which is a decision rather than a
  gap.
- `README.md` — datalets, joining versus cloning, and what a clone code hands
  over.
