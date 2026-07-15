# `@hypercarrier/hc-key-msg-summary`

This Pi extension materializes a complete, branch-scoped Key Message
projection. It selects every persisted textual user message plus textual
assistant prose from `stop` and `toolUse` (continuation) responses. Tool calls,
tool results, and reasoning blocks are excluded; assistant prose is retained
even when the same response also contains a tool call.

The projection preserves every ordered occurrence and its source reference.
Identical text payloads are represented once with all occurrence IDs, so the
selection is inspectable without duplicating raw prose in the sidecar.

Only an agentically dense branch calls Pi's effective default model:
`toolCallCount > 50 || continuationCount > 50`. Below that threshold the
append-only record has status `selection_only` and no provider call occurs.
There is no last-N option or fallback. If the complete generated prompt exceeds
`maxPromptChars`, the record is `unavailable_overflow`; no text is silently
truncated.

The native Pi JSONL is never modified. For a normal persisted Pi Session, the
private append-only sink mirrors its storage path under
`~/.pi/agent/session-summaries/`: for example,
`sessions/<cwd-key>/<session>.jsonl` becomes
`session-summaries/<cwd-key>/<session>.jsonl`. It records session and branch
identity, a selection manifest hash, selector/dedupe/prompt/model/implementation
versions, and the derived result. Project association is optional downstream
metadata, not a condition for materialization. Raw prose stays in Pi's Session
evidence.

Every actual model synthesis also adds a private machine-only receipt to that
same append-only sidecar: requested and provider-reported model identity,
local duration, provider request/response IDs when exposed, reported token
usage, and Pi's reported estimated USD cost when available. The receipt never
stores the prompt, provider response text, arbitrary headers, or guessed token
counts. Its `usage.availability` is `reported`, `partial`, or `unavailable`,
and each retained field names the exact response path it came from.

It materializes on Pi `session_start` (including reload, resume, and fork) and
on `agent_end`. Reloading an older session can therefore produce its first
sidecar without waiting for another user prompt; identical branch inputs are
deduplicated by their manifest-derived identity.

When synthesis—not merely selection-only materialization—starts in an
interactive Pi TUI, the extension emits a non-blocking TUI notification, then
reports success or a generic failure. These are `ctx.ui.notify` calls only:
they do not add a Session entry, custom message, tool call, or model-visible
content. Duplicate and already-in-flight inputs stay quiet.

The extension resolves `defaultProvider` plus `defaultModel` from normal Pi
settings; a trusted Project's `.pi/settings.json` can override those standard
settings. Direct callers may inject `config.model` and `modelClient` for tests
or a deliberately separate embedding. The package owns no provider/model
default and does not inherit the transient `ctx.model`.

```js
import { processKeyMessageSummary } from "@hypercarrier/hc-key-msg-summary";

await processKeyMessageSummary(ctx, {
  model: { provider: "openrouter", id: "cheap-model" },
  modelClient: { complete: async () => ({ text: "Progress: ..." }) },
});
```

The prompt requests a concise, one-line `Progress`, `Findings`,
`Questions/Requests`, and `Next step` summary. It may summarize only the
complete selected Key Message projection, not runtime, delivery, priority, or
intervention state.
