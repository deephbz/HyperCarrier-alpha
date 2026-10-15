# HyperCarrier Auto Compact

Auto Compact owns the compaction lifecycle, preservation policy, and method
selection. Pi owns Session mutation and native history. Control notices are
projections. They do not prove durable preservation.

## Preservation, method, and execution

Configure these fields in Pi's `auto_compact` namespace:

```json
{
  "auto_compact": {
    "preservation": "artifact-handoff",
    "method": "native",
    "execution": "foreground"
  }
}
```

These values preserve the existing defaults. `/auto-compact status` reports
the effective selection. `/auto-compact off` still enforces W through plain
native compaction, regardless of the selected method.

- `preservation`: `artifact-handoff` requests the existing durable-work handoff.
  `none` skips that request and reports `HANDOFF (skipped)`.
- `method`: `native` uses Pi's existing compaction-hook lane. This can include
  Blackmagic when loaded. `summary` and `keepset` use Auto Compact's planner.
  Both use the canonical Rarebit selector from `@hypercarrier/rarebit/core`
  over Pi's active projection. The budgeted record retains user messages,
  agent continuations (`toolUse`), and agent stops (`stop`). Extension messages
  are excluded. Assistant prose from turns that ended with `length`, `error`,
  or `aborted` is excluded. The planner carries needed extension content into
  its summary. For content a tool can read again, it keeps the tool and the
  recovery ID.
  `keepset` also assembles selected tool output and a dropped-output index.
- `execution`: `foreground` requests a planning turn in the live conversation.
  The model calls `compaction_plan({summary, keep})` as its final action. The
  controller holds input and delivery during that turn, then installs the plan
  after settlement. The request keeps the live Session's provider, prefix, and
  replayed reasoning. Both Auto Compact tools stay declared from Session start.
  Tree navigation restores that inventory after Pi restores the selected
  branch's historical tool loadout, including branches from older Sessions.
  Their execution gates
  accept calls only in the matching pending phase.
  A missing plan uses the existing settled native fallback.
  `background` captures the next ordinary provider request at A,
  then starts its side request when A streams content. The conversation and
  human input remain live until installation. Pi retains every entry after A
  through `firstKeptEntryId`. A missing anchor, newer compaction, or changed
  captured projection rejects the plan. An idle trigger waits for the next
  ordinary request; it does not create a main-conversation request.

Background requires `method: summary|keepset`. Native background is rejected.
With `preservation: artifact-handoff`, background runs no live handoff turn.
The fork returns `{summary, keep, handoff}` as one structured plan and executes
no tools. `handoff` is a nonempty handoff record of intent, progress,
decisions, unresolved work, and next steps as of A. `pre_compact_prompt` guides
it. Installation places the record in the compaction summary after the
working-state summary, under a heading that names entry A and states that later
turns supersede it. The record is clipped to 4,000 tokens and counted in
`details.autoCompact.handoffTokens`. A plan without a handoff is rejected.
A rejected plan leaves no record. The record lives only in Session context;
Auto Compact writes no handoff file. A later compaction keeps it only if that
compaction summarizes it. A race-free durable file record and crash recovery
are deferred to the pi-durable harness migration.
Background supports `anthropic-messages`, `openai-responses` and
`openai-codex-responses`. It rejects other model APIs, such as
`openai-completions`, before starting; use foreground there. An
Anthropic fork appends the handoff text to the last user message. A Responses fork
keeps the captured `input` and appends one user item, so the provider's automatic
prefix cache can serve the captured prefix. Codex forks use SSE and send the
captured `prompt_cache_key` as `session-id`, because the Codex backend routes its
cache by that header. OpenAI caching is automatic and needs no Cache Goblin
marks. A routed payload model that differs from `ctx.model.id` is rejected before the fork.
Custom methods require Pi 1.1's `buildSessionProjection`. Background also
requires custom compaction usage and the side-request API. Install Goblin and
all other payload modifiers before Auto Compact. Capture runs inside its
`before_provider_request` handler; later payload rewriting is unsupported. Cache cooperation
uses `cache-goblin:pin`, `cache-goblin:unpin`, and `cache-goblin:placed`.
Cache absence does not block correctness.
Through magpie's Claude subscription bridge, an Anthropic fork reads only the
shared prefix from the cache. The bridge starts the fork in a new Claude Code
run, and that run's prompt cannot match the turns the live run cached
(measured: 4,613 of 20,137 tokens). Through the Anthropic API, the fork reads
the whole captured prefix. See yetone/magpie#1717.

Do not load either independent keepset experiment extension with Auto Compact.
Do not load another custom compaction generator alongside summary/keepset
unless it honors the `hc.compaction-method` claim. Auto Compact emits
`{owner: "hc-auto-compact", method, active: true, token}` before `ctx.compact`
and releases the same token on completion or cancellation. Cooperating
Blackmagic versions skip generation for an active custom-method claim; native
checkpoint replay remains independent. Older generators can override a hook
result and make duplicate paid requests.

Background records side-request usage in `CompactionEntry.usage`. It retains
Pi's optional `cacheWrite1h` and `reasoning` breakdowns. These fields are subsets
of `cacheWrite` and `output`; they do not increase totals again. Foreground
planning usage remains on the native assistant entry and is not counted twice.
The current
assembly limits are 24,000 kept-tool tokens, 8,000 tokens per item, and 12,000
conversation-record tokens. These estimates use characters/4. The foreground
planner uses the main Session's output configuration. An Anthropic background
fork limits `max_tokens` to the native history cap, and an `openai-responses`
fork limits `max_output_tokens` the same way when the captured request has it;
without it the fork is uncapped. Codex requests carry no output
limit, so a Codex fork has none; status shows `background output cap none
(provider default)`. The fork is content-identical through A. Its output cap and
stream transport can differ. An explicit captured Anthropic thinking budget must
be below the reduced fork cap. Auto Compact checks that
limit before dispatch; it does not rewrite thinking or prefix content to fit.
Oversized background inputs or incompatible provider payloads fail without automatic
native fallback. The owner hook returns explicit cancellation when it rejects
a custom plan. It resets that workflow, releases custody, claims, and pins, and
requests no pickup. It does not throw into Pi's fail-open hook dispatcher. This
path differs from the deliberate foreground missing-plan native fallback.
Background plans require a nonempty string `summary` and a string array `keep`.
The reply must contain a valid `compaction_plan` call, complete JSON, or one
complete JSON code fence. Arbitrary text, partial JSON, surrounding prose,
trailing junk, and output-limit termination are rejected. Rejection keeps the
live context and requests no installation or pickup. Retained assistant prose
uses the neutral `AGENT` label; it does not imply successful completion.
Dropped output is not copied to files; native Session history remains the
recovery source.

## Load from a HyperCarrier checkout

Install the repository dependencies, then load the extension directly into Pi:

```sh
npm ci
pi -e "$PWD/packages/hc-auto-compact/src/extension.mjs"
```

Run `/auto-compact status` inside Pi to confirm that the extension is loaded
and inspect its effective settings before relying on an automatic handoff.
The HUD and status show the method phase: waiting for request, computing, or
waiting to install. Skipped-preservation custom work is labeled planning.
Status separates configured selection from the active run snapshot when they
differ. Native and background paths show native output caps. Custom foreground
planning shows the model output ceiling. Session request settings can lower it.

## Package map

`package.json` owns the public export map:

- [`.`](src/index.mjs) aggregates the existing public exports.
- [`./extension`](src/extension.mjs) registers the Pi extension.
- [`./controller`](src/controller.mjs) owns lifecycle state and Pi effects.
- [`./command`](src/command.mjs) owns command parsing and completion.
- [`./settings`](src/settings.mjs) owns settings resolution and persistence.

[`src/presentation.mjs`](src/presentation.mjs) renders human projections, and
[`src/threshold.mjs`](src/threshold.mjs) owns threshold validity. They are
private implementation modules, not package export-map entries.
[`src/method-engine.mjs`](src/method-engine.mjs) owns cancellable planner work.
`src/methods/` owns assembly, manifest, and payload-fork helpers. Neither owns
an independent lifecycle controller.

## Runtime contract

### Lifecycle and handoff

This section describes the default artifact-handoff/native/foreground mode.
With preservation `none`, native execution moves directly to `ready`.
Background execution always moves directly to `ready`. Foreground custom methods wait for the live planning tool.

The runtime lifecycle is `idle → [queued →] handoff_pending → ready → compacting
→ pickup → idle`. At the configured context threshold, the extension requests a
visible custom handoff Session event. The zero-argument `auto_compact_ready`
tool accepts readiness only while that handoff is pending. Its exact immutable instruction remains the
agent-addressed historical record. Automatic and idle manual handoffs preserve
`{ triggerTurn: true, deliverAs: "steer" }` delivery behavior; a busy manual run
queues the same event with `deliverAs: "followUp"`. The agent preserves work in durable
Project artifacts, calls that tool as its final action, and Pi's native compact
flow starts after `agent_settled`. If the handoff settles without readiness,
the controller forces compaction. An aborted handoff cancels instead. At
`turn_end`, a pending or ready handoff at or above W requests compaction at
once. Its receipt reports the token overshoot. One turn can exceed W; this is
not a strict request-admission bound.

### No-inspection invariant

Because the handoff starts near the context limit, its framework-owned
instruction forbids further reads, searches, browsing, log inspection, and
verification. The agent must use only context already present to make the
minimum safe durable write; when no safe write is possible without inspection,
it proceeds to readiness without inspecting. Configured preservation guidance
can select what to preserve but cannot relax this no-inspection invariant.
The handoff also forbids assistant text to the human. Progress appears after
pickup.

### Delivery, pickup, and human projections

The handoff event uses custom type
`auto-compact.handoff`; both the normal and external-corrective visible pickup
events use `auto-compact.pickup`. Handoff steers and triggers a turn; an
unprompted normal pickup without held input triggers a turn. A prompted manual
pickup or a pickup with held input does not trigger a turn; its paired user
message starts or steers the continuation;
corrective pickup does not trigger a turn.

The transcript shows the handoff collapsed to one line: what the agent was asked
to do and how many tool results the manifest lists. The `compaction_plan` call
shows the summary size and keep count. Pi removes both blocks when compaction
ends, so the pickup also carries a human view of the installed plan in
`details.plan`: method, execution, plan summary, handoff record, kept labels,
and rejected labels. The model does not read `details`. Expand a block with
the `app.tools.expand` key (default Ctrl+O) or, in fullscreen mode, a left
click on that block.

In TUI mode, the above-editor HUD is a separate
transient, one-line current-control projection:
`AUTO COMPACT · <MANUAL|AUTOMATIC> · <phase>`. Its phases identify handoff
awaiting readiness, ready awaiting turn end, compacting, pickup requesting the
continuation, or unresolved external-compaction resolution; it never repeats
the instruction or outcome. The HUD exists only while a cooperative workflow
owns current control, including an interrupted workflow awaiting matching
external-compaction resolution. Completion or cancellation removes the
workflow HUD. A compaction error retains a separate failure HUD. The
exact prompt snapshot and last terminal workflow remain inspectable on demand
through `/auto-compact status` until a new run or Session/active-branch
boundary. Every normal pickup carries `details.runToken`. Without held input,
the controller keeps `pickup` and the delivery hold active until `message_start`
or `context` observes that exact custom message. With held input, custody ends
only when `context` contains the token-bearing pickup and the expected user
messages in order. Admission proves that Pi received the messages; it does not
prove that the agent acted on them. An idle watchdog checks for missing admission
every 5 seconds. It surfaces undelivered held input and releases the hold on failure.

During `handoff_pending`, `ready`, and `compacting`, the `input` hook holds
input from all sources when `ctx.hasUI` is true (TUI or RPC). The HUD shows
`· held N`. Queued handoffs, pickup, print, and JSON modes do not capture input.
Background planning does not capture input or hold delivery. Installation and
pickup use the existing custody contract. Pi runs extension commands before
this hook. Input rejected before the hook
is outside this guarantee.

With held input, the custom pickup contains only the priority instruction and
any manual run prompt. It does not trigger a turn. The controller sends the
first held item as a user message with its own images. Once that user message
starts, it steers each remaining item into the same agent run, in order.
Pi can deliver the items in separate model turns of that run. Each item becomes
a user entry in Session history. Interactive text stays verbatim;
non-interactive text keeps the `[via source]` line. Held templates and skills
do not expand. Earlier extensions can transform or handle the input again.
An item whose delivered text differs from the expected text stays in custody
and is restored for resubmission when the idle watchdog fires. The recovery
notice covers text that also appears in chat. A steered item can briefly appear
in Pi's queued-steering area before its user message appears.
Input after the pickup send follows ordinary Pi delivery behavior.

On failure or cancellation, the controller first appends a recovery entry
`auto-compact.held-input` in the source Session. It records text, source, and
image count. TUI restores text ahead of the current editor text; RPC receives
the full text in a notification. Images cannot be restored. On Session or
branch boundaries, the controller surfaces the old text and never sends it
to the new target. It does not append an entry after the source Session has
changed. The notice warns operators to discard the editor copy if the message
also appears in chat. Process crashes lose the in-memory batch.

The extension emits `hc.delivery-hold` on `pi.events` with
`{ holder: "hc-auto-compact", token, active }`. Each run has a fresh UUID.
The hold starts before handoff send, or when a queued handoff is delivered.
It renews every 10 minutes and ends on pickup admission or a terminal outcome.
Only senders that honor this signal participate. PTB owns its separate gate
and a 30-minute fail-open lease; native compaction holds remain independent.
The controller never filters foreign context messages.

### Configuration and commands

Configuration is durable under `auto_compact` in Pi settings. A trusted
Project command writes `.pi/settings.json`; otherwise it writes the global
`~/.pi/agent/settings.json`. Project fields override global fields.

```json
{
  "auto_compact": {
    "enabled": true,
    "threshold": 90,
    "budget_tokens": 200000,
    "pre_compact_prompt": "Also record the current verification command and its last result."
  },
  "compaction": { "reserveTokens": 32768 }
}
```

`budget_tokens` is an optional positive integer. Budget resolution is:
Session branch override → `auto_compact.modelOverrides["provider/id"].budget_tokens`
→ `budget_tokens` → real `model.contextWindow`. Project model overrides win per
key. Effective W is `min(budget, model.contextWindow)`. Threshold, forced stop,
and footer use that same W. Status shows the configured budget, its source,
effective W, and `clamped to model window` when needed. A changed W controls
the next `turn_end`; the command does not compact immediately.

Keep each physical model in one provider with its true `contextWindow`.
Remove logical override providers created only to supply smaller working
windows. Use the physical model and the recommended 200k budget and 32768
reserve shown above. The budget belongs to Auto Compact; Pi's own footer
window figure shows capacity. Budget enforcement exists only while this
extension is loaded.

| Guarantee | Limit |
| --- | --- |
| R2: With the true window as `model.contextWindow`, the budget never clamps the native summary. | Native caps remain floor(0.8R) for history and floor(0.5R) for a split prefix, bounded by `model.maxTokens`. Summary demand can still exceed those caps. |

Auto Compact publishes the `context.budget` slot on `pi.events` through
`hc.hud.slot`. The `hc-hud/1` payload is
`{ v: 1, key: "context.budget", producer: "hc-auto-compact", asOf, value }`.
`asOf` is the observation time in epoch milliseconds. The value is
`{ kind: "ratio", used, limit: W, unit: "tokens", capacity, mode, threshold }`.
`capacity` is the true model window. `mode` is `auto`, `off`, or `disarmed`.
A compaction failure sets `disarmed` until a re-arm condition clears the
failure. Optional `phase` is `handoff` while preservation or readiness is
active, or `compacting` during cooperative or plain native compaction.
Optional `held` counts inputs still in custody, including pickup awaiting
admission. Zero held inputs omit that field. The slot contains semantic values
and no rendered text or ANSI sequences. It updates at Session start, turn end,
compaction, budget change, and each control-state or custody transition,
including non-TUI modes. Unknown usage and shutdown publish `value: null`.
Budget values do not decay, so the producer omits `staleAfterMs`.
Model selection immediately recomputes W and refreshes the slot and fallback
under the Session-generation fence without changing the requested budget or
control state.

The producer listens for `hc.hud.composer` with
`{ v: 1, present, surface: "tui-footer" }`. On `present: true`, it replays the
latest slot with its observation time and clears its native status fallback.
Publication and replay discard observations from an older Session generation.
On `present: false`, it restores that fallback. Before any composer is seen,
the TUI status shows `budget <used>/<W> <pct>% · <auto|off|disarmed>` with compact k and
M units (`1.0M` for one million). Unknown usage hides it. Theme warning colour
starts at the threshold; error colour starts at 100% of W. The composer owns
HUD presentation; Auto Compact retains budget authority.

Native summary caps use `compaction.reserveTokens` (Pi default 16384), with
`compaction.modelOverrides["provider/id"].reserveTokens` taking precedence.
History output is capped at floor(0.8R); split-turn prefix output is capped at
floor(0.5R). Both caps are bounded by `model.maxTokens`. Status shows both caps
and a status-only warning for thinking with a small prefix cap. These are
output limits, not a measured guarantee that thinking and summary will fit.

After a compaction error, automatic handoff stays disarmed even if usage drops.
Status retains the error and caps. HUD shows the failure. Re-arm requires a
successful compaction, a settings command, `/auto-compact run`, or a changed
reserve value observed at `turn_end`. An aborted handoff or idle pickup
watchdog also re-arms the threshold. Status retains own-run native usage and
`tokensBefore`; it labels usage aggregate when both summary calls ran.

After a reserve-file edit, the controller re-arms when it reads the new value
at `turn_end`. Pi's native compactor can still use its cached old reserve and
output cap. Run `/reload` or restart Pi after changing
`compaction.reserveTokens`. Status shows configured caps; re-arm alone does
not refresh Pi's native settings cache.

`enabled` defaults to `true`; `threshold` defaults to `90` and must be greater
than `1` and less than `110`. Values above `100` deliberately keep automatic
handoffs armed without crossing under ordinary percentage accounting.
`pre_compact_prompt` is additional preservation
guidance inside the framework-owned handoff; it cannot authorize context
gathering.

Use `/auto-compact` or `/auto-compact status` to inspect effective
configuration and runtime state. `/auto-compact on`, `/auto-compact off`, and
`/auto-compact threshold <percent>` persist configuration. `off` disables
cooperative handoff but still enforces W. Both tools stay declared for the whole
Session, including off mode and method native. Out-of-phase calls state the
current phase and next action. Idle refusals direct the model to continue work
until an Auto Compact notice asks for a tool. A threshold crossing requests plain
native compaction after `agent_settled`, without a handoff, delivery hold, or
input capture. Plain compaction uses the same failure record and disarm rules.

Status uses aligned rows and compact token units (`30.8k`, `1M`). The header
shows ON, OFF, or DISARMED after a failure. OFF still enforces the native
budget. `next` shows the next run's selection; `active` appears only when its
captured policy differs. Limits describe the active path. Failures and recovery
actions precede the unchanged workflow receipt.

Switch the next run without editing settings:

```text
/auto-compact execution foreground|background|default
/auto-compact execution fg|bg
/auto-compact fg
/auto-compact bg
/auto-compact method native|summary|keepset|default
/auto-compact preservation artifact-handoff|none|default
```

These selections are temporary memory overrides. `default` restores the saved
setting for that key. Status marks each override with `*` and the legend
`temporary: resets on /reload or Session switch`. Same-Session tree navigation
retains the selection. Session start and shutdown clear it. No settings file or
Session entry records these switches. The branch budget has a separate lifetime.

A valid switch re-arms future admission and refreshes status. It does not start
compaction or change an active lifecycle, planner job, tool set, or method claim.
An invalid switch changes nothing, including an invalid `default` reset. For
background from native, use `/auto-compact method keepset` then `/auto-compact bg`.
To restore native from background, use `/auto-compact fg` then
`/auto-compact method native`. Preservation never changes implicitly. Command
completion includes selection values.

`/auto-compact budget <tokens|default>` accepts positive integers and k units
such as `400k`. It appends `auto-compact.budget` as a native Session custom entry
and does not change settings files. The latest entry on the active branch
restores the override during tree navigation. Resume and restart restore it
from a persisted Session. `default` records a reset and returns to
model/settings resolution. Budget changes do not create or replace a
delivery-hold token.

Accepted gap: Pi does not persist a message-less Session file. A budget set
before any messages can be lost after switching away and back. The override
survives after a normal model turn persists the Session. This command does not
force Pi to write an otherwise empty Session file.
`/auto-compact run` starts the same handoff manually even when automatic mode
is off. When Pi is busy, every manual run queues behind current steering and
earlier follow-up work, regardless of whether the operator submitted it with
Enter or Pi's configured follow-up key. Pi executes registered extension
commands before exposing their submit behavior, so the extension cannot safely
distinguish those keys; making every busy manual run a follow-up preserves the
requested ordering. The queued HUD remains visible, but Pi's public pending-text
and dequeue projections omit queued custom messages, so dequeue cannot restore
the command text to the editor. Both Auto Compact tools remain schema-visible
throughout the Session. Their state gates reject premature, stale, and idle calls
without terminating work. This fixed inventory protects cache prefixes on direct
Anthropic and magpie's OpenAI-compatible route. No tool-change compat flags are
required. Reloading an older Session can change its inventory once.
Only delivery of the exact run-token-bearing handoff makes readiness valid, and
an undelivered queued run terminates without compaction when the agent settles.

`/auto-compact run <prompt...>` binds a nonempty prompt to that manual
lifecycle only: after successful native compaction, the normal visible
`auto-compact.pickup` event is requested first with `{ triggerTurn: false }`,
then the unchanged prompt is requested as the sole continuation turn. With
held input, the prompt stays in the untriggered custom pickup; held user
messages start or steer the continuation instead.
Zero-argument manual and automatic pickups without held input trigger a turn.
External-corrective pickups do not trigger a turn.

### Session scope and evidence

Pending handoffs, lifecycle identifiers, readiness, and threshold latches are
Session-local in-memory state and are ephemeral. The controller uses a
turn-budget stop and a settled-handoff fallback. It has no handoff wall-clock
timeout. The human receipt and its TUI
card are also Session-local projections: the controller retains at most one
current and one last run, renders the card only for an active workflow, and
clears both receipts on Session or active-branch boundaries. Receipts are not
durable evidence. Held-input recovery entries are durable Session evidence. Native Pi Session history remains
historical evidence; the extension's custom handoff/pickup messages are
derived control projections. Native threshold compaction is suppressed while
the extension is loaded, but manual and overflow compaction remain available
and interrupt a pending handoff cleanly.

### Diagnostics and verification

For focused tests or private diagnostics, `createAutoCompactController` accepts
an `onDebug(record)` callback and exposes `snapshot()`. Normal TUI output does
not include lifecycle IDs or raw diagnostics.

Run `npm test --workspace @hypercarrier/hc-auto-compact` for deterministic
package coverage. `npm run test:e2e --workspace @hypercarrier/hc-auto-compact`
starts a live Pi RPC canary, so it requires configured model credentials and
incurs provider usage. It defaults to `openai-codex/gpt-5.6-sol:minimal`; use
`PI_E2E_PROVIDER`, `PI_E2E_MODEL`, and `PI_E2E_THINKING` to override it. The
canary prints and retains its raw RPC JSONL and native Session directory under
a fresh temporary artifact directory.

From a source checkout, `node packages/hc-auto-compact/scripts/integration-runtime-verification.mjs`
checks the combined extensions through installed Pi 1.1 RPC and a local Messages
fixture. It makes no paid provider calls. `integration-openai-background.mjs --paid <provider>/<model> <summary|keepset> <none|artifact-handoff>`
runs one live background compaction on a Responses model with the agent
directory's credentials. It checks the captured prefix, installation, side-request
cache reuse and post-compaction recall. It holds the side request until request
A and one later turn settle, so it does not test overlapping requests or a
tool-call retry of the fork. Evidence goes under
`~/.local/share/pi-compaction-evidence/openai-background/`. The separate
`integration-anthropic-smoke.mjs` requires `--paid`, an explicit
`PI_CODING_AGENT_DIR`, and human spending authorization. Its request guards cover
main and side requests. Provider receipts establish observed cache reuse; they
do not establish preservation quality or general savings.
