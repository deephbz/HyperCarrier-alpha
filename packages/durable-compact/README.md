# @hypercarrier/durable-compact

HyperCarrier Auto Compact on pi-durable, used by
[AmPi](../../apps/ampi/README.md). pi-durable owns the compaction task, the cut,
and the history. This package supplies the budget mapping and the summary.

- `workingBudget(window, {thresholdPercent, budgetTokens})`: the working
  budget W. pi-durable 1.3.0 has no per-model compaction settings, so the AmPi
  node owns the W trigger and calls `compact()` itself.
- `compactionSettings(opts)`: the harness compaction settings. The verbatim
  keep defaults to min(20000, W/4) when a budget is set.
- `hcCompactExtension({history, record})`: a `beforeCompact` hook that writes
  three sections: the model's working-state summary, the Rarebit conversation
  record (newest first, 12k-token cap, over the full durable history), and an
  index of dropped tool results. If the model call fails, it records a
  `native-fallback` and pi-durable writes its own summary.
- `CompactRecord`: one receipt per compaction (method, reason, trigger,
  sections).

Not ported: artifact handoff turns and input custody. A durable run never
loses input during compaction.

Behavior is tested end to end through AmPi (`apps/ampi/test/compact.test.ts`).
