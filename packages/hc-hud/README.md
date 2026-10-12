# HyperCarrier HUD

## Governance

Purpose: give the operator one compact, always-on view of a Pi Session.
Scope: compose native Pi data and producer-owned semantic slots in the TUI footer.
Status: consolidation; the v1 contract is provisional.

The HUD is a projection. Producers own slot truth. Pi owns Session history.
The composer owns the footer while present. It creates no store, process,
cross-process bus, Task authority, or identity. Pane and Session labels remain
presentation. Global ecosystem docs and diagrams belong to the lead's change.

## Load and inspect

```sh
pi -e ./packages/hc-hud/src/extension.mjs
node --test packages/hc-hud/test/*.test.mjs
```

Use `/hud tier auto|full|compact|minimal` to select a Session-local tier.
Auto selects the richest complete representation that fits each line's actual
terminal width. Lines adapt independently. The Session name stays first in all
tiers. Path detail shrinks before the Session disappears. If no representation
fits, lower-priority slots drop before the remaining text truncates.
Explicit tiers retain their representation but still obey width limits.
A long optional slot can force a simpler representation before it drops.

Use `/hud slots` to inspect values, producer, `asOf`, and staleness.
RPC loads the extension and supports the command. It does not claim a TUI footer.

Set display aliases under `hc_hud.model_aliases` in Pi settings:

```json
{ "hc_hud": { "model_aliases": { "provider/claude-fable-5-1": "provider/fable5.1" } } }
```

Trusted project settings override global aliases per key. Aliases never change
wire model IDs. Thinking suffixes remain separate from configured aliases.

## Contract `hc-hud/1`

[`src/contract.mjs`](src/contract.mjs) owns validation and Session-local slot
ownership. Producers emit `hc.hud.slot` through `pi.events`:

```js
{
  v: 1, key: "context.budget", producer: "hc-auto-compact", asOf: Date.now(),
  value: { kind: "ratio", used: 133100, limit: 200000, unit: "tokens",
    capacity: 1000000, mode: "auto", threshold: 90 }
}
```

`value: null` retracts a slot. Optional `staleAfterMs` applies only to values
that decay. An expired value stays visible with a dimmed `?`.
A crashed producer's last value never shows as stale without `staleAfterMs`.
The no-composer fallback shows two context figures with different denominators.
The first producer claims each key for the Session. A foreign update or
retraction is ignored with one warning per key. New Session startup clears all
slots and claims. Old timestamps cannot replace a newer value or retraction.
Values contain no ANSI or control sequences. Unknown fields are ignored.

Kinds: `ratio`, `identity`, `label`, `count`, and `status`.
Known keys: `context.budget`, `team.member`, and reserved `rarebit.summary`.
Unknown keys use their kind's generic formatter after known slots.
Budget modes include `auto`, `off`, and `disarmed`. Optional `phase` is
`handoff` or `compacting`; optional `held` counts held inputs.

The composer emits `hc.hud.composer` with
`{v:1, present:true, surface:"tui-footer"}` before it calls `setFooter`.
Producers synchronously remove footer wrappers, clear status fallbacks, and
replay their slots. The composer re-announces when a new producer first
publishes after startup. On shutdown it clears the footer before it emits
`present:false`. Producers then restore their fallback. Presence applies only
to the named surface. The in-process signal is not a lease or durable authority.

## Colour intent

The footer stays neutral at rest. Colour distinguishes budget pressure,
control activity, failure, and pending delivery in separate spans.
Routine compaction does not imply failure. Held input does not imply a human
must act. An expired value stays uncertain, including a recorded failure.

Pi's theme owns the colours. The HUD uses semantic theme roles and does not
set a palette. Path, separators, and accounting stay muted. The Session name
stays readable. Model and healthy context stay neutral. `NO_COLOR` or an
absent theme preserves the same plain text, tiers, and width rules.
Actual contrast depends on the active theme and terminal; it is not guaranteed.

## Source map

- [`src/composer.mjs`](src/composer.mjs): native collection, Pi usage accounting,
  presence, lifecycle, and footer installation.
- [`src/visual-language.mjs`](src/visual-language.mjs): pure semantics, followed
  by TUI tiers, glyphs, slot order, priority, and painting.
- [`src/extension.mjs`](src/extension.mjs): lifecycle registration, settings,
  and `/hud`.

Literal golden tests cover layout, content-fit boundaries, and degraded states. Cost spans all native Session entries. Cache hit uses the latest
assistant prompt, as Pi's FooterComponent does. The display floors its percent.
Existing extension statuses keep Pi's sorted third-line presentation.
