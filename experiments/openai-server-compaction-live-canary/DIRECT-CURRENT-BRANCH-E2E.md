# Direct current-branch compaction E2E

As of: 2026-07-30

## Question

Can the reduced extension compact the owner-nominated failing Pi Session without request capture, calibration, provider wrappers, or extension configuration, then replay across fresh processes?

## Method

The canary used a private read-only copy of the nominated Session. The copy ended immediately after the observed Auto Compact handoff tool result. The source Session was not modified. Raw Session data, RPC streams, provider material, and the replay observer remain under ignored `private/` storage.

A fresh Pi process loaded the exact `0.1.0-rc.3` source later released at commit `7ba0de2bdbad083ab646ff8ca67b8a262d78a246` from the global package list. RPC requested manual compaction. Another fresh process continued the compacted Session while a final read-only observer recorded only whether an opaque compaction item reached provider input. Recall checked facts that occurred before compaction. The sequence then repeated to test compaction of an already replay-backed branch.

## Result

The first compaction returned `remote_applied` through `codex_compaction_trigger_v2`. Pi persisted both its readable summary and the opaque checkpoint. No predictive calibration ran.

The first fresh process observed opaque replay in provider input and recalled the pre-compaction facts correctly. A second remote compaction also returned `remote_applied`. A second fresh process again observed opaque replay and returned correct recall.

The sanitized machine receipt is `artifacts/pi-direct-current-branch-e2e.json`.

## Interpretation

The owner-reported failure was architectural. Provider-call capture and cross-request calibration were not part of server compaction, so unrelated extension activity could disable the feature. Direct serialization of Pi's authoritative active branch removes that coupling and supports the failing handoff shape on the first attempt.

This validates authenticated ChatGPT Codex apply, repeated apply, fresh-process replay, and recall. Official OpenAI Responses and Azure OpenAI Responses still need authorized live canaries. Their deterministic protocol and package tests remain separate evidence, not live proof.
