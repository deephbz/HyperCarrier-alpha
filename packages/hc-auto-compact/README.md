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

The runtime lifecycle is `idle → handoff_pending → ready → compacting → pickup
→ idle`. At the configured context threshold, the extension requests a visible
custom handoff Session event and temporarily enables the zero-argument
`auto_compact_ready` tool. Its exact immutable instruction remains the
agent-addressed historical record, while preserving `{ triggerTurn: true,
deliverAs: "steer" }` delivery behavior. The agent preserves work in durable
Project artifacts, calls that tool as its final action, and Pi's native compact
flow starts after the agent run settles. The handoff event uses custom type
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
than `0` and less than `95`. The prompt has a preservation-focused default.

Use `/auto-compact` or `/auto-compact status` to inspect effective
configuration and runtime state. `/auto-compact on`, `/auto-compact off`, and
`/auto-compact threshold <percent>` persist configuration.
`/auto-compact run` starts the same handoff manually even when automatic mode
is off. `/auto-compact run <prompt...>` binds a nonempty prompt to that manual
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
