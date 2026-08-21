# Plan: More Than One Datalet

**Status: active.** D1 landed 2026-08-21; D2 and D3 have not started. Written
2026-08-21 from the code as it stood at `bc82c8c` and kept current as work
lands.

Today the app holds exactly one graph. `usePrivateNuri` resolves to either this
device's `private_store_id` or, once paired, the vault's id — and pairing
*switches* rather than adds. There is no list, no switcher, and no way back to
a graph you have left.

This plans a **datalet**: one named, self-contained instance of the app — its
schemas, tabs, blocks, widgets, theme and records — of which you may hold
several and use one at a time. The model is Joplin's profiles: reference
material in one, current notes in another, switching between them, never both
at once.

## Why this is not feature creep

It adds no capability to a datalet. Nothing new can be modelled, stored, or
rendered; the reader and builder are untouched. It changes only how many
instances you may keep and how you move between them — a reframing, not an
extension.

It is also less new mechanism than it looks. The engine is already
multi-graph: the in-memory store is keyed `${graph}|${id}`, persistence keys
are `…:record:<graph>|<id>`, `exportGraphBackup(graph)` already filters by
graph, and subscriptions already filter by graph scope. Most users have two
graphs in localStorage right now without knowing it, because pairing
deliberately leaves the previous unpaired graph in place. The work is largely
to expose what exists.

---

## The constraint that shapes everything

Chromium accepted **~5.2 million characters** of localStorage for this origin
before refusing — measured, not assumed. `RUNTIME_LIMITS.storedBytes` is
4,000,000 and is compared against `.length`, so the two are the same unit. One
datalet at its full allowance therefore consumes about **77% of everything the
origin gets**.

That rules out holding several datalets resident at once: whether a second one
fitted would depend on how large the first had grown, so the same action would
succeed or fail unpredictably. Inconsistency of that kind is worse than a flat
restriction.

**So only the active datalet is resident.** Switching away evicts; switching
back restores. Which forces the central rule:

> A datalet you are not using must be recoverable from somewhere. That
> somewhere is its vault. **Holding more than one datalet therefore requires
> each of them to be paired.**

This is not a quota workaround. It is what "only one resident" means: an
unpaired datalet has no second copy, so evicting it would destroy it.

Local-only use is unchanged and whole — one datalet, no network, exactly as
today. Multi-datalet is a capability of the sync tier, which is a coherent
place for it to live rather than a compromise.

## What this is not

**Not two datalets open at once.** No side-by-side, no cross-datalet queries,
no references between them. One is active; the rest are inert.

**Not a merge.** A datalet is switched to, never merged into. Every graph
carries `did:ng:z:HomeTab` and `did:ng:z:SettingsSingleton`, so merging would
collide on well-known ids by construction.

**Not IndexedDB.** Considered and refused: it reintroduces the migration
[`roadmap.md`](roadmap.md) rejected, and leaves two storage engines with
different durability and different failure modes. The cost of refusing it is
the arithmetic above, accepted knowingly.

---

## D1. Account for storage honestly — **completed 2026-08-21**

Useful immediately with a single datalet, and a prerequisite for the rest.

**Measure the whole origin, not just records.** The current guard projects the
size of record keys and the index. It does not count the sync outbox
(`meta-ui-builder:sync-outbox:<vaultId>`), the cursor, the session, or the
vault config — all of which sit in the same 5.2M budget. An outbox that grows
through a long offline stretch is the most plausible unmodelled consumer. Sum
every key instead, so the budget is the real one.

**Re-derive the cap rather than keeping a guess.** 4,000,000 was a conservative
figure chosen without measurement. What is now known: this Chromium refuses at
~5.2M characters; 5 MiB (5,242,880) is the long-standing convention across
browsers that have localStorage at all; Firefox allows 10 MiB. A working cap of
**4,500,000 with the origin measured whole** keeps roughly 700k of headroom for
everything else and is defensible against the smallest plausible browser.

`navigator.storage.estimate()` is the wrong instrument and should not be
reached for: it reports the origin's overall storage quota, which is orders of
magnitude larger than the separate localStorage sub-limit, so it would report
gigabytes of headroom that localStorage will not give.

**Landed detail, and one thing writing the test found.** Two paths, because
they want different things. The write path keeps its incremental projection and
measures foreign keys only once the cheap figure crosses 80% of the budget —
below that, no plausible outbox closes the gap. The settings panel scans the
origin physically instead, and that difference is not cosmetic: a store
rejected at load for being over the cap *clears its own accounting while every
record stays on disk*, so a figure derived from bookkeeping would report near
zero for a browser that is completely full. The scan is affordable there
because it is not on the write path.

Record key names are now counted too. The browser charges for `key + value`,
and a record key carries a graph-qualified id, so at a few thousand records the
names are not noise.

**Surface it.** A usage figure in Settings — used against cap, as a percentage
— that becomes prominent as it climbs. Quiet under a low threshold, plain
above it, insistent near the limit. The failure it exists to prevent is the app
silently refusing to persist, which today produces a runtime issue banner with
no warning that it was coming.

## D2. Datalets: a list, a name, and a switcher — **medium**

A datalet needs identity the user recognises. **The name already exists**: each
graph has its own `Settings.appTitle`. The list labels itself from data.

- A stored list of datalets: `{ graph, vaultId, vaultToken, nodeId }` per
  entry, plus which is active.
- **This is the one genuinely structural change.** `getVaultConfig()` reads a
  single key, so pairing is global rather than per-datalet. The sync engine has
  to be told which datalet it is operating for instead of consulting the one
  true config. Every caller of `getVaultConfig` is affected.
- The unpaired local graph is the first entry, not a special case.
- Switching reloads the page. Precedented: pairing and import already reload
  deliberately, because replacing a whole graph is simpler and more robust than
  re-targeting every live subscription.
- Each entry shows its size, so the cost of keeping another is visible at the
  moment you would add one.

## D3. Evict on switch, restore on return — **medium, the risky one**

Leaving a datalet removes its records from localStorage; returning fetches them
back from its vault. `fetchAndReconcileSnapshot` already does the restoring
half — it is what pairing runs before its reload.

Three rules, each protecting against a way this loses data:

- **Never evict an unpaired datalet.** There is no other copy. In practice the
  UI must refuse to add a second datalet until the current one is paired, so
  the situation cannot arise.
- **Never evict with a non-empty outbox.** The outbox is already keyed per
  vault (`OUTBOX_PREFIX + vaultId`), so this is checkable. If the server is
  unreachable and edits are queued, the datalet is not evictable yet and
  switching must say so rather than proceed.
- **Evict after the restore succeeds, not before.** Switching should never
  leave both the old datalet gone and the new one unfetched.

## D4. Where cloning lands — **out of scope here, noted for shape**

A cloned datalet becomes **a new entry in the list**, leaving the current one
undisturbed. Without D2 a clone would have to replace what you are working on,
which is a strange thing to do to someone. That is the whole reason this plan
comes first.

---

## Ordering

D1 alone, shipped and lived with. It is useful with one datalet and it is how
the constraint becomes visible before anything depends on it. Then D2, which is
where the structural change to vault configuration happens. D3 last: it is the
only part that can destroy data, and it should be built against a list that
already works.

## Testing strategy

Both existing harnesses extend; the storage arithmetic is the part worth
proving hardest, because its failures are silent.

| Item | Tests |
| --- | --- |
| **D1** | Unit: the budget sums every localStorage key, so an outbox and an index are inside it rather than beside it; a projection that would cross the cap refuses whole, as `persistNow` already does. Playwright: usage climbs as records are added; the indicator changes prominence at each threshold; a store already over the cap reports rather than corrupts. |
| **D2** | Playwright: two datalets exist and are listed by their own `appTitle`; switching reloads into the other one's records and theme; the first entry is the local graph; the sync engine operates against the active datalet's vault, not a global one. A regression that the *inactive* datalet's records never appear in the active one's subscriptions — the graph filter is what keeps them apart. |
| **D3** | Playwright, all three rules as separate cases: an unpaired datalet cannot be evicted; a datalet with a queued outbox entry refuses to be left and says why; a failed restore leaves the original intact and switches nothing. Plus the round trip — write, switch away, switch back, records identical. |
| **Whole** | A datalet at the cap plus a second one is refused at the point of creation, not at the point of saving. That is the inconsistency this plan exists to avoid, so it should be asserted rather than assumed. |

## Risk summary

| Risk | Where | Mitigation |
| --- | --- | --- |
| Switching loses unsent edits | D3 | Outbox must be empty and confirmed; refuse the switch otherwise |
| Switching loses everything | D3 | Restore before evict, never the reverse |
| An unpaired datalet is evicted | D3 | Cannot be added as a second datalet while unpaired; no path reaches the case |
| Quota exceeded by unaccounted keys | D1 | Budget measures the whole origin, not record keys alone |
| Cap too high for some browser | D1 | 4.5M against a measured 5.2M and a 5 MiB convention; the usage figure makes a wrong guess visible rather than fatal |
| Multi-datalet quietly becomes sync-only *marketing* | — | Local-only remains a complete product with one datalet; the restriction is stated as what it is |

## Effect on existing documents

- `architecture.md` — §1.3's storage layout and the single-graph assumption in
  §4's `usePrivateNuri` description.
- [`product-assessment.md`](product-assessment.md) — "one person's devices"
  becomes "one person's datalets, one at a time"; the 4 MB cap is re-derived
  and the sync tier gains a second reason to exist.
- [`roadmap.md`](roadmap.md) — record that IndexedDB was refused again here,
  for a second and different reason.
- `README.md` — datalets, switching, and why more than one needs sync.
