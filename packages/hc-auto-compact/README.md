# HyperCarrier Auto Compact

Auto Compact is a Pi extension that cooperatively preserves work before using
Pi's native compactor. It does not replace compaction or treat its own notices
as Session truth.

## Load from a HyperCarrier checkout

Install the repository dependencies, then load the extension directly into Pi:

```sh
npm ci
pi -e "$PWD/packages/hc-auto-compact/src/extension.mjs"
```

Run `/auto-compact status` inside Pi to confirm that the extension is loaded
and inspect its effective settings before relying on an automatic handoff.

## Runtime contract

The runtime lifecycle is `idle → [queued →] handoff_pending → ready → compacting
→ pickup → idle`. At the configured context threshold, the extension requests a
visible custom handoff Session event and temporarily enables the zero-argument
`auto_compact_ready` tool. Its exact immutable instruction remains the
agent-addressed historical record. Automatic and idle manual handoffs preserve
`{ triggerTurn: true, deliverAs: "steer" }` delivery behavior; a busy manual run
queues the same event with `deliverAs: "followUp"`. The agent preserves work in durable
Project artifacts, calls that tool as its final action, and Pi's native compact
flow starts after the agent run settles. Because the handoff starts near the
context limit, its framework-owned instruction forbids further reads, searches,
browsing, log inspection, and verification. The agent must use only context
already present to make the minimum safe durable write; when no safe write is
possible without inspection, it proceeds to readiness without inspecting.
Configured preservation guidance can select what to preserve but cannot relax
this no-inspection invariant. The handoff event uses custom type
`auto-compact.handoff`; both the normal and external-corrective visible pickup
events use `auto-compact.pickup`. Handoff steers and triggers a turn; an
unprompted normal pickup triggers a turn, while a prompted manual pickup does
not because its paired ordinary user message starts the sole continuation;
corrective pickup does not trigger a turn. In TUI mode, the above-editor HUD is a separate
transient, one-line current-control projection:
`AUTO COMPACT · <MANUAL|AUTOMATIC> · <phase>`. Its phases identify handoff
awaiting readiness, ready awaiting turn end, compacting, pickup requesting the
continuation, or unresolved external-compaction resolution; it never repeats
the instruction or outcome. The HUD exists only while a cooperative workflow
owns current control, including an interrupted workflow awaiting matching
external-compaction resolution, and every terminal outcome removes it. The
exact prompt snapshot and last terminal workflow remain inspectable on demand
through `/auto-compact status` until a new run or Session/active-branch
boundary. `PICKUP` means the continuation instruction was requested; it is not
evidence that the request persisted or that the agent acted on it.

Configuration is durable under `auto_compact` in Pi settings. A trusted
Project command writes `.pi/settings.json`; otherwise it writes the global
`~/.pi/agent/settings.json`. Project fields override global fields.

```json
{
  "auto_compact": {
    "enabled": true,
    "threshold": 90,
    "pre_compact_prompt": "Also record the current verification command and its last result."
  }
}
```

`enabled` defaults to `true`; `threshold` defaults to `90` and must be greater
than `1` and less than `110`. Values above `100` deliberately keep automatic
handoffs armed without crossing under ordinary percentage accounting.
`pre_compact_prompt` is additional preservation
guidance inside the framework-owned handoff; it cannot authorize context
gathering.

Use `/auto-compact` or `/auto-compact status` to inspect effective
configuration and runtime state. `/auto-compact on`, `/auto-compact off`, and
`/auto-compact threshold <percent>` persist configuration.
`/auto-compact run` starts the same handoff manually even when automatic mode
is off. When Pi is busy, every manual run queues behind current steering and
earlier follow-up work, regardless of whether the operator submitted it with
Enter or Pi's configured follow-up key. Pi executes registered extension
commands before exposing their submit behavior, so the extension cannot safely
distinguish those keys; making every busy manual run a follow-up preserves the
requested ordering. The queued HUD remains visible, but Pi's public pending-text
and dequeue projections omit queued custom messages, so dequeue cannot restore
the command text to the editor. Pi snapshots active tools for a low-level agent
run, so the ready tool is schema-visible while the typed handoff waits in that
run's queue; its state gate rejects premature calls without terminating work.
Only delivery of the exact run-token-bearing handoff makes readiness valid, and
an undelivered queued run terminates without compaction when the agent settles.

`/auto-compact run <prompt...>` binds a nonempty prompt to that manual
lifecycle only: after successful native compaction, the normal visible
`auto-compact.pickup` event is requested first with `{ triggerTurn: false }`,
then the unchanged prompt is requested as the sole continuation turn. Zero-argument
manual runs, automatic runs, and external-corrective pickups retain their
existing delivery behavior.

Pending handoffs, lifecycle identifiers, readiness, and threshold latches are
Session-local in-memory state and are ephemeral. There is deliberately no
forced-compaction timeout: if the agent never signals readiness, the pending
handoff remains inspectable through `status`. The human receipt and its TUI
card are also Session-local projections: the controller retains at most one
current and one last run, renders the card only for an active workflow, and
clears both receipts on Session or active-branch boundaries. They are not
durable evidence. Native Pi Session history remains
historical evidence; the extension's custom handoff/pickup messages are
derived control projections. Native threshold compaction is suppressed while
the extension is loaded, but manual and overflow compaction remain available
and interrupt a pending handoff cleanly.

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
