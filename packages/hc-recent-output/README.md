# `@hypercarrier/hc-recent-output`

This package is a deliberately narrow Pi projection. It listens to
`agent_settled`, reads the active `ctx.sessionManager.getBranch()`, selects the
last `N` assistant messages with `stopReason: "stop"`, at least one text block,
and no `toolCall` block, and sends only extracted text to a configurable cheap
model. It never writes into the Pi Session.

The default model is `openrouter/z-ai/glm-5.2`, but the model client is
injectable. The Pi extension statically resolves Pi 0.80.6's
`@earendil-works/pi-ai/compat` contract, and the package manifest declares
that exact runtime dependency plus its `pi.extensions` entry. Direct library
callers should inject `modelClient` or the `piAi` contract.

Each materialization is an append-only JSONL record with a semantic input hash,
attempt/materialization IDs, selected message IDs/content hashes, source
window, model/prompt/version, and status. Failures are retryable attempts;
different successful outputs for one input identity are appended as explicit
`conflict` records. A short output lock protects identity reservation while a
renewable lease covers the model call, so slow calls don't hold a stale lock or
lose an active claim.

Prompt contract `recent-output-v2` requires exactly one physical line with the
ordered labels `Progress`, `Findings`, `Questions/Requests`, and `Next step`.
The adapter enforces that shape after the model call, fills absent sections
with `None stated`, collapses hostile/control newlines, and bounds each section
without changing selected-message lineage.

Project association is opt-in by configuration: `config.projectId` or
`HC_PROJECT_ID` is required before a model call. Unassociated settlements are
skipped without sending text unless the caller explicitly sets
`allowUnassociated: true`. The sink defaults to
`~/.local/state/pi-session-timeline/<projectId>/recent-output.jsonl` and is
created `0600` with verified/chmodded `0700` private directories. Existing
symlinks and unsafe ownership fail closed. A crash-truncated final JSONL record
is preserved as a raw `.tail` file under `<sink>.quarantine` before appending.

## Library use

```js
import { processSettlement } from "@hypercarrier/hc-recent-output";

await processSettlement(ctx, {
  n: 3,
  model: { provider: "openrouter", id: "z-ai/glm-5.2" },
  modelClient: { complete: async ({ prompt }) => ({ text: prompt }) },
  projectId: "project-alpha",
  outputPath: "/private/path/recent-output.jsonl",
});
```

The model is instructed to report only stated progress, findings,
questions/requests, and next step in one compact physical line. Selected messages are serialized as a JSON
payload explicitly marked untrusted, rather than interpolated into a synthetic
message-tag envelope. Raw selected text still crosses the configured provider
boundary, so use a local/injected model or pre-redaction for sensitive
sessions. Runtime, priority, delivery, Project truth, and intervention
judgments belong to other projections.
