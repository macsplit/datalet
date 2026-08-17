# Plan: The Theme in the Graph

**Status: complete.** T1 through T5 landed 2026-08-17. T6 was **declined**, not
deferred — see below. Written 2026-08-17 from the code as it stood at
`b4ec878` and kept current as work landed.

The visual theme is the last part of "the app" that is still hardcoded. Tabs,
blocks, widgets, schemas and settings are already ordinary records; the palette
is not. Moving it into the graph completes the property this project already
claims — *the app definition is data* — rather than extending it. A theme set
on the laptop then appears on the phone, is included in a JSON backup, is
undoable, and replicates across tabs, none of which needs building: those all
follow from being a record.

The work is cheap because `src/styles/global.css` is already token-shaped: 950
lines, but **228 CSS custom properties**. Nothing needs restructuring. A theme
is a set of values for a curated subset of those tokens, and a whole theme is
well under 1 KB against the 4 MB cap — a different order of magnitude from the
file and image problem, which is why the same reasoning does not apply.

## What this is not

**Not a theme manager.** One active theme, stored on the existing Settings
singleton. No gallery, no named themes, no import/export of themes as a
separate artifact — a theme travels in the ordinary graph backup like
everything else.

**Not arbitrary CSS from the graph.** Only an allowlisted set of token names,
each with a validated value. The graph is untrusted input: it arrives through
JSON import and through a vault whose token another person may hold.

**Not webfonts from the network.** A font is chosen by id from a vendored set.
Storing a URL would make the browser fetch from a third party on every load —
and because import is a supported path, importing someone's backup would
silently make your browser call their server, leaking IP, timing and referrer
before you had looked at anything. That is a category change, not a
performance question: it ends the "no network code on any path, verifiable by
reading the source" property that unpaired mode currently has honestly.

**Not font bytes in the graph.** A woff2 subset is only ~1% of the cap, which
makes it more tempting than an image, but it re-opens the binary-in-the-JSON-
path decision [`roadmap.md`](roadmap.md) closed on purpose and would cross the
sync path as JSON. It stays deferred under that existing decision rather than
being decided separately.

---

## T1. Content Security Policy — **completed 2026-08-17**

There is currently **no CSP anywhere** — not in `index.html`, not in
`server/src/staticServer.ts`. Landing one first means the rest of this work is
developed under the constraint instead of retrofitted into it, and it is worth
doing on its own merits regardless of themes.

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
font-src 'self'; img-src 'self' data:; connect-src 'self';
object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

- `font-src 'self'` is the point: it makes "the graph cannot cause an outbound
  request" a guarantee the browser enforces, rather than a convention every
  future contributor has to remember.
- `style-src` needs `'unsafe-inline'` — React sets style props, and T3 injects
  a `<style>` element. Say so plainly; it does not weaken the font guarantee.
- `img-src` keeps `data:` because the QR pairing view renders one.
- `connect-src 'self'` assumes the sync server is same-origin, which
  [`remote-sync-deployment.md`](remote-sync-deployment.md) already requires via
  the reverse proxy. A split-origin deployment would have to widen it, and that
  should be a deliberate, documented change rather than a discovery.

Set it in **both** places: a `<meta http-equiv>` in `index.html`, so it applies
however the built app is served, and a response header in `staticServer.ts`,
which is authoritative when the sync server serves it. `frame-ancestors` is
ignored in a meta tag, so that directive only takes effect via the header.

**Landed detail.** The meta tag is injected by a build-only Vite plugin, not
written into the source `index.html`: `@vitejs/plugin-react` serves its refresh
preamble as an inline module script, which `script-src 'self'` blocks, and
loosening the policy to accommodate a dev-only script would weaken what ships.
The consequence is that the main Playwright suite — which runs against
`vite dev` — never exercises the policy at all. This plan originally claimed
those suites were the regression; they are not. The offline suite serves the
built app, so the CSP tests live there instead, including one asserting the
browser actually blocks a cross-origin font.

## T2. Token allowlist and value validation — **completed 2026-08-17**

A fixed list of token names a theme may set, and a validator for values.

- **Colour roles only in v1** — roughly fourteen: `bg`, `surface`,
  `surface-alt`, `border`, `text`, `text-muted`, `text-subtle`, `accent`,
  `accent-hover`, `accent-text`, `danger`, `success`, `chip`, `badge`.
  Dimension tokens (spacing, radii, type scale) are deliberately out of v1;
  they change layout rather than appearance and are easy to add later.
- **Values must match a strict colour grammar**: `#rgb`, `#rrggbb`,
  `#rrggbbaa`, or `rgb()`/`rgba()`/`hsl()`/`hsla()` with numeric arguments.
  Reject anything containing `url(`, `\`, `/*`, `;` or `}` whatever else it
  matches, and cap each value's length.
- A value that fails validation is **dropped, not corrected** — the token falls
  back to the stylesheet default and the problem is reported through
  `reportRuntimeIssue`, consistent with how the engine already treats a
  corrupted stored record.

This is the same instinct as `sanitizeLabel` in `server/src/neo4j/labels.ts`:
splice nothing into a language from stored data without an allowlist first.

## T3. Storage on the Settings singleton — **completed 2026-08-17**

Two optional string fields per colour role (`…Light` and `…Dark`), plus
`fontFamily`, added to `src/shapes/shex/settingsShapes.shex` — which currently
holds exactly one field, `appTitle`. Roughly 29 fields in total.

**Every field optional.** Absent means "use the stylesheet default", so an
existing graph renders identically and there is no migration.

Rejected alternatives, both worth recording:

- **One JSON blob field.** Tiny shex, but it makes the whole theme a single
  last-write-wins value, so two devices changing different colours clobber each
  other — and it puts an opaque blob inside a graph store, which is the thing
  this architecture avoids everywhere else.
- **A `ThemeToken` record type.** Fully graph-native and would allow multiple
  themes, but it adds a sixth metadata type and ~30 records to support a
  feature with exactly one instance. The five-types story is worth more than
  the generality.

Per-field storage means two devices editing different colours merge correctly
under the existing per-field HLC rules, with no new conflict logic.

Requires `pnpm build:orm` and committing the regenerated `src/shapes/orm/*`.

## T4. Applying the theme — **completed 2026-08-17**

Generate a **single `<style id="graph-theme">` element** in `<head>` from the
validated tokens, rewritten whenever the Settings record changes:

```css
:root { --color-bg: …; … }
@media (prefers-color-scheme: dark) { :root { --color-bg: …; … } }
```

**Do not use `documentElement.style.setProperty`.** Inline properties beat a
media query, so setting tokens that way silently breaks dark mode for every
user who picks a theme — the app would stop following the system preference
and nobody would connect the two. This is the single most likely bug in the
feature, and generating a stylesheet instead of inline properties removes the
possibility rather than documenting it.

Only allowlisted names are ever emitted, after T2's validation.

**Landed detail, and a correction to this plan's own testing advice.** The
regression test was written as "with dark emulated, a light+dark theme applies
the dark value" — and it *passes under the broken implementation*, because
writing the dark palette last happens to leave the right value in force. The
test that actually fails is the inverse: **with light emulated, a light+dark
theme must apply the light value**, since the naive version leaves the
last-written (dark) value in place regardless of scheme. Both are kept; only
the light-mode one has been verified to fail against a deliberately broken
build.

## T5. Settings UI — **completed 2026-08-17**

A theme section in Settings: a light and a dark colour input per role, and a
Reset that clears the fields back to stylesheet defaults. It reads and writes
the existing `useSettings` singleton, so no new subscription and no new
metadata plumbing.

**Landed without the font selector this plan originally listed**, because T6
was declined; there is nothing for it to select between.

## T6. Vendored fonts — **declined 2026-08-17**

The plan was to ship three to five open-licensed woff2 subsets and store the
chosen id in the graph. **Not built, and not deferred.**

The system font stack is already the right answer. It renders text people can
read, in the typeface their device is designed around, at zero bundle cost and
with no network surface. Shipping alternatives would add 100–200 KB against a
415 KB bundle, plus licence files, plus a precache list to keep in step, to
support a preference that changes nothing about whether the app works.

The honest framing is that this is an **opinionated** product, not a design
tool. Colour is configurable because a tracker someone looks at daily benefits
from being theirs; typeface selection is the beginning of a layout-and-
typography surface that has no end, and that this project has no business
competing on. Anyone who wants that has an application for it already.

The two font positions this leaves are both decisions rather than gaps:

- **No webfont URLs in the graph**, because import is a supported path and a
  stored URL would make importing a backup fetch from a third party. Enforced
  by T1's `font-src 'self'`.
- **No font bytes in the graph**, under the existing file-and-image deferral in
  [`roadmap.md`](roadmap.md).

Revisit only alongside a decision that this should be a design tool, which
would be a different product.

---

## Ordering

T1 first — independent, valuable alone, and it makes everything after it
develop under the constraint. Then T2 → T3 → T4 as one coherent piece; none of
them is useful alone. T5 made it usable.

T6 was placed last precisely because it had the largest bundle impact and was
the easiest to drop if the system stack turned out to be fine. It did, and it
was.

## Testing strategy

Both existing harnesses extend; nothing new is needed.

Client-side pure functions are already tested from the Node runner —
`server/test/pairingCode.test.ts` imports `src/utils/pairingCode.ts` directly —
so T2 and T4 follow that precedent rather than inventing a third harness.

| Item | Tests |
| --- | --- |
| **T1** | `contentSecurityPolicy.test.ts` asserts the header on every static response (not just the document), that `font-src`/`script-src` cannot be widened unnoticed, and that only the header form carries `frame-ancestors`. `offline.spec.ts` — the only suite serving the built app — asserts no `securitypolicyviolation` fires while using it, and that the browser blocks a cross-origin `@font-face`. |
| **T2** | Unit: every accepted colour form round-trips; `url(https://…)`, a backslash, a comment sequence, a stray `;` or `}`, and an over-long value are each rejected; a rejected value leaves the token unset rather than empty. |
| **T3** | Playwright: a theme survives reload, appears in a JSON backup export, and reaches a second tab. Absent fields render identically to an unthemed graph. |
| **T4** | Unit: generated CSS contains only allowlisted names, and emits both the plain and the `prefers-color-scheme: dark` block. **Playwright with `colorScheme` emulation — and the light-mode direction is the one that matters**: with both palettes stored, light mode must show the light value. The dark-mode assertion passes even against the broken implementation, so it proves nothing on its own. Verified by breaking the implementation on purpose and watching the light-mode test fail. |
| **T5** | Playwright: editing a colour updates the computed value live; Reset restores the default. |
| **T6** | Not applicable — declined. The precache trap it would have introduced is documented above in case fonts are ever revisited. |
| **Hostile input** | Playwright: import a backup whose theme value contains `url(https://example.invalid/f.woff2)`. Assert the value is rejected, a runtime issue is reported, and — via route interception — that no request to that origin is ever made. This is the test that encodes *why* URLs are refused. |

## Risk summary

| Risk | Where | Mitigation |
| --- | --- | --- |
| Dark mode silently stops following the system | T4 | Generate a stylesheet with a real media query, never inline properties; `colorScheme`-emulated test |
| Stored CSS becomes an injection channel | T2 | Name allowlist plus value grammar; hostile-import test; CSP as the backstop |
| Themed app stops working offline | T6 | Removed with T6: a colour theme is a record like any other, so it needs no asset and cannot miss the precache list |
| CSP breaks a split-origin deployment | T1 | `connect-src` documented in the deployment guide as assuming a same-origin proxy |
| Unreadable theme locks the user out | T5 | Reset control that clears every field; values are ordinary records, so undo also reaches them |
| Scope drift into a theme manager | — | One active theme on Settings; multiple themes would need the rejected `ThemeToken` type and should be refused on that basis |

## Effect on existing documents

- `architecture.md` — the metadata model gains theme fields on Settings, and a
  short section on how a stored theme becomes a stylesheet.
- [`product-assessment.md`](product-assessment.md) — theme-as-data belongs in
  "What it actually is" as the completion of the thesis, and the "no network
  surface" claim becomes browser-enforced rather than conventional.
- [`roadmap.md`](roadmap.md) — record that webfont URLs and font bytes are out
  of scope on purpose, with the reasoning above, so they are not mistaken for
  oversights.
- `README.md` — the theme section of Settings, and font credits.
- [`remote-sync-deployment.md`](remote-sync-deployment.md) — the CSP, and the
  same-origin assumption in `connect-src`.
- `build-history.md` — one row per landed step.
