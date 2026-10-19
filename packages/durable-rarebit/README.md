# @hypercarrier/durable-rarebit

Rarebit on pi-durable, used by [AmPi](../../apps/ampi/README.md). Selection
reuses `@hypercarrier/rarebit` unchanged. Product semantics reuse `@hypercarrier/rarebit` unchanged.

- `toPiBranch(entries)`, `select(entries)`: map durable entries (user and
  assistant only; `team.notice` and other extension entries excluded) onto the
  canonical Rarebit selection. The input is the full durable history, so
  compaction never hides evidence.
- `RarebitDoc` (`rarebit.state`, conversation scope, fork `initial`): the
  latest Summary receipt, the last attempt (summarized, ineligible, or error),
  the in-flight run (with the node boot id), the trigger, and the Title.
- `deriveSummary`, `deriveTitle`: pure derivations over an injected
  `complete()` model call. `agent_settled` applies the eligibility policy;
  `manual` skips it. `freshness` says whether a Summary covers the latest
  evidence.
- `rarebitExtension(source)`: the `rarebit_recall` tool (query, role, limit;
  replay-safe) and the `rarebit` prompt section.

Behavior is tested end to end through AmPi (`apps/ampi/test/rarebit.test.ts`).
