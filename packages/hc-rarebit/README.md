# `@hypercarrier/hc-rarebit`

Rarebit is a sparse, deterministic evidence projection over the active branch
of a persisted Pi Session. It selects every textual user message and textual
assistant `toolUse`/`stop` prose; it excludes tool payloads/results and hidden
reasoning. Native Pi Session JSONL remains the raw evidence authority.

Rarebit keeps three different things separate:

- **Rarebit evidence** is the ordered selected raw prose and provenance.
- **Rarebit Summary** is an optional lossy model derivation over that complete
  evidence.
- **Rarebit Title** is a mutable human-facing Session-label proposal, not
  Session identity or evidence.

The official human presentation of Rarebit evidence and Summary results is
explained in [`VISUAL-LANGUAGE.md`](VISUAL-LANGUAGE.md) and exposed to consumers
by `src/rarebit-visual-language.mjs`; semantic roles, statuses, and reasons
remain authoritative in `src/types.d.ts`.

The package has one backend with two shells. The functional core owns the
Rarebit predicate, branch measurement and eligibility policy, prompt
composition, output normalization, and deterministic job identity. The shared
imperative services own model invocation, private append-only receipts, and
cross-process dedupe for both Summary and Title. The Pi extension contributes
lifecycle triggers, TUI notifications, an explicit Session-label apply adapter,
and an optional Herdr recency HUD adapter; `hc-rarebit` contributes argument parsing, native-Session lookup, JSON
output, and proposal-only Title behavior. Neither shell redefines selection,
policy, prompts, model receipts, or persistence.

## Pi extension

Configure a dedicated model rather than inheriting the interactive model:

```json
{
  "rarebit": {
    "model": "openai-codex/gpt-5.6-luna",
    "min_total_length": 80000,
    "max_rarebit_ratio": 0.4,
    "auto_title": true
  }
}
```

`min_total_length` is an explicitly labelled model-independent estimate:
`ceil(all readable active-branch message characters / 4)`. `max_rarebit_ratio`
is selected Rarebit characters divided by that same raw character denominator.
Automatic synthesis requires both thresholds; it never silently falls back to
the interactive `defaultModel`. The only automatic lifecycle paths materialize
in detached work after persisted direct owner input and after normal settlement.
`session_start` (including reload or resume) initializes extension/session/title
bookkeeping only: it never schedules a Summary, queries policy, resolves or
calls a model, writes a receipt, or notifies. Each new receipt preserves its
writable lifecycle boundary: an `owner_request` Summary is always
`user_requested/owner_request_recorded`, while settled/manual summaries classify
complete selected evidence as `finished/all_requests_accomplished` or
`needs_attention` with a decision, input, approval, blocker, or unfinished reason. Settled classification sees
only selected user and assistant boundary prose: tool calls/results are
intentionally absent, so their absence is not evidence that work failed. A
final assistant handoff that says or conventionally signals completion, such as
`done`, makes the request appear accomplished unless selected prose positively
reports failure, deferral, remaining work, a blocker, or a need for owner input.
`unfinished` likewise requires positive selected evidence, not a missing tool
transcript. `finished` remains a Session-scoped appearance assessment, never
Project or delivery truth. It does not block prompt entry or add model-visible
messages.

After intrinsic eligibility but before model resolution, the Pi shell emits the
versioned `rarebit-automatic-summary-policy/1` query on Pi's shared extension
event bus. Providers may only inhibit or abstain. Exactly one fresh compatible
inhibition produces a private `inhibited` receipt; absence, timeout, failure,
malformed/stale responses, or conflicting inhibitions fail open. The query is
operation-specific: it does not affect deterministic extraction, explicit
`/rarebit summarize`, Title, status/query, evidence, or attention semantics.

`/rarebit summarize` requests a deliberate forced summary. `/rarebit title`
is a deliberate generated retitle. Automatic title generation uses the exact
first persisted direct interactive/RPC owner message and never overwrites an
existing title. After resume, an explicit generated retitle may use the
earliest persisted user Rarebit when runtime origin provenance is unavailable;
the receipt labels that weaker evidence `branch_user_fallback`. Both paths
revalidate the exact active Session and unchanged prior title immediately
before applying the local `YYYYMMDD-` label. Use Pi's native `/name` command
for a literal title.

When Pi runs under Herdr, the optional adapter reports `rarebit_user_age` and
`rarebit_stop_age` metadata tokens from the latest selected user-role and
assistant-stop occurrence. It refreshes every 30 seconds with a 90-second TTL;
these are recency clocks only, not liveness, progress, or delivery state.

The extension exposes only `/rarebit`, with `status`, `config`, `auto-title`,
`title`, `summarize`, and `recall` subcommands. `/rarebit recall <prompt...>`
is human-only: while Pi is idle, it writes the exact active-branch Rarebit
selection to a private per-invocation OS-temp directory. The lightweight
`rarebit-conversation.json` groups ordered user/agent content into chronological
UTC hour buckets, with a single `hour: null` bucket when source time is
unavailable; the detailed `rarebit-evidence.json` retains Session, branch,
selection, message identifiers, timestamps, hashes, and lineage. The extension
then requests one visible persistent `rarebit.recall` custom event naming and
explaining both files with `{ triggerTurn: false }`, followed by an unchanged
`<prompt...>` ordinary user-message request that starts the one turn. It
registers no model-visible tool. Missing prompts, busy Sessions, changes during
materialization, and extraction/materialization failures send neither message.
The temp directory is mode 0700 and both JSON files are mode 0600.

`config max_rarebit_ratio <0..1>` and `config min_total_length <nonnegative
estimated tokens>` are validated process-local overrides; the settings file
remains the durable default. Pi's native argument completion offers the
subcommands, config keys, and `on`/`off` values from the same grammar used for
parsing and usage help.

Successful v4 compact receipts contain free-form `summary`, `sessionStatus`,
and `statusReason`; they don't require Progress/Findings/Questions/Next-step
sections. Summary and Title derivations use the current v4 protocol, and no
receipt contains branch-entry, occurrence, or payload arrays.

Live consumers use the exported `projectRarebitArtifactState` producer state
machine instead. Native Session JSONL owns the current branch and selection,
while the exact mirrored sidecar owns receipt status, Summary, and lifecycle
lineage. Its typed input distinguishes `available`, `missing`, and `unreadable`
for each artifact, and its result exposes sync state, flat projection,
applicability, artifact references, and retry guidance. Owner-request receipts
remain applicable through assistant continuations only when the package
recomputes their compact manifest reference as the strict current native prefix
and their user anchor is still the latest user. Only `agent_settled` ends that generation; historical valid v4
`session_start` receipts remain readable immutable evidence but cannot be newly
derived, while `manual` receipts may assess an exact selection without settling it. Sidecar-only projections are explicitly source-pending, never
claims of native currentness; session conflicts, malformed receipts, and
unsupported protocol versions fail closed. The projector never reads Summary
prose.

Private append-only v4 materializations mirror Session paths beneath
`~/.pi/agent/rarebit/materializations-v4/`. Each compact receipt is followed by
one `rarebit_head` containing its absolute UTF-8 byte offset, newline-inclusive
length, and SHA-256 hash. `readRarebitCurrent` reads only a bounded file tail
and the referenced receipt; `readRarebitHistory` is the explicit bounded audit
path. A torn final tail leaves the preceding complete head current, while a
complete invalid head fails closed as `sidecar_head_invalid`. Other
materialization namespaces aren't read or translated. Job claims live beneath
`~/.pi/agent/rarebit/jobs-v4/`. Receipts retain no raw selected prose, prompt,
provider response body, headers, or credentials.
Inhibition receipts retain only provider/reason, contract/freshness, and opaque
identity/generation/association provenance.
Directories are mode 0700; materialization and lease files are mode 0600.
Session commit locks are opaque-token fences and are never reclaimed by age.
If a process crash leaves `<sidecar>.commit-lock`, first verify that no Rarebit
writer for that exact Session is alive, then remove only that lock file; normal
writers otherwise fail closed rather than risking an ABA overwrite.

## CLI

```sh
hc-rarebit query --session <exact-path-or-id> --json
hc-rarebit extract --session <exact-path-or-id> --json
hc-rarebit summarize --session <exact-path-or-id> --json
hc-rarebit title --session <exact-path-or-id> --json
```

`query` is metadata-only. `extract` returns raw selected Rarebit evidence on
demand from native Session JSONL. Normal `summarize` and `title` call a stripped
ephemeral Pi print process with the same declared `rarebit.model`, Pi auth, and
provider configuration; they load no extensions, tools, skills, context files,
or Session. `--model-command` is an explicit advanced adapter override. The
CLI title returns a date-prefixed proposal and never mutates a Session label.
