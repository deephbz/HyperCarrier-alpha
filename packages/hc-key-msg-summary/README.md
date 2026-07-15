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

The outbound provider prompt contains only ordered semantic `role`, `outcome`,
and `text` fields. Hashes, occurrence/source IDs, timestamps, producer
metadata, versions, and storage coordinates remain in the private sidecar's
machine-facing manifest and receipt; they are not paid model input.

It materializes on Pi `session_start` (including reload, resume, and fork) and
when a user submission from Pi's `interactive` or `rpc` source has been
persisted. Both paths are detached from Pi's awaited lifecycle chain: synthesis can show
TUI notifications, but it does not block prompt entry or queue a new submission
behind the summary call. At most one materialization runs at a time; triggers
that arrive meanwhile collapse into one rerun against the latest captured
Session branch. Reloading an older session can therefore produce its first
sidecar without waiting for another user prompt, while identical branch inputs
remain deduplicated by their manifest-derived identity.

`agent_end` is deliberately not a trigger. The adapter observes an aborted
`agent_end` only to discard unfinished input-origin bookkeeping; pressing ESC
during thinking, tool use, or continuation produces no summary checkpoint.
Inputs whose Pi source is `extension` are also excluded from the
user-submission trigger.

When synthesis—not merely selection-only materialization—starts in an
interactive Pi TUI, the detached worker emits a TUI notification, then reports
success or a generic failure. These are `ctx.ui.notify` calls only:
they do not add a Session entry, custom message, tool call, or model-visible
content. Duplicate and already-in-flight inputs stay quiet.

The triggered notice shows Key Message count, requested model, and a clearly
marked `~N` input-token estimate using Pi's `ceil(prompt characters / 4)`
display heuristic; provider usage does not exist before its response. The
updated notice reads only provider-reported `synthesis.usage.inputTokens` and
`outputTokens`, preferring the reported provider/model and otherwise using the
requested model. Missing usage is shown as `unavailable`; the local estimate
is never written into the machine receipt or presented as reported usage.

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

## Agent query CLI

Agents can query the same selector directly from native Session evidence:

```sh
hc-key-messages --session <exact-path-or-id> --json
```

An exact path reads that file. An ID must match exactly one Session below
`~/.pi/agent/sessions`; zero or multiple matches fail closed. The command walks
from the final persisted entry through its parent chain, so abandoned branches
are excluded, then applies the package's shared Key Message selector. Its JSON
contains the Session/active-leaf reference and ordered semantic Key Messages;
content hashes and synthesis manifests stay machine-internal. It never writes,
migrates, summarizes, joins Beads, or infers a Project/workspace.

Legacy version-1 Sessions are linear and have no entry IDs, so the command
selects their records in persisted order and returns `null` source/leaf IDs
without inventing or persisting replacements. Absolute source paths and the
Session header's `cwd` are deliberately absent from normal JSON output.
