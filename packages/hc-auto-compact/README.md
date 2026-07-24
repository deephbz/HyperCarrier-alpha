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
→ idle`. At the configured context threshold, the extension inserts a hidden
custom handoff notice and temporarily enables the zero-argument
`auto_compact_ready` tool. The agent preserves work in durable Project
artifacts, calls that tool as its final action, and Pi's native compact flow
starts after the agent run settles. A separate hidden pickup notice starts the
continuation turn after successful compaction. The TUI handoff receipt repeats
the exact agent instruction so the operator can inspect what was sent without
opening debug or provenance detail. In TUI mode that receipt is a persistent
above-editor lifecycle card, not a Session entry or agent-context message. The
card labels the text as framework-generated hidden context rather than user
input and repeats the exact immutable instruction while `HANDOFF` is active.
After readiness it collapses the prompt while updating through
`HANDOFF → COMPACT → PICKUP`, then retains the last terminal workflow until a
new run or Session/active-branch boundary.
The same prompt snapshot and workflow remain inspectable through
`/auto-compact status`. `PICKUP` means the continuation instruction was sent;
it is not evidence that the agent acted on it.

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
is off.

Pending handoffs, lifecycle identifiers, readiness, and threshold latches are
Session-local in-memory state and are ephemeral. There is deliberately no
forced-compaction timeout: if the agent never signals readiness, the pending
handoff remains inspectable through `status`. The human receipt and its TUI
card are also Session-local projections: the controller retains at most one
current and one last run, and clears both on Session or active-branch
boundaries. They are not durable evidence. Native Pi Session history remains
historical evidence; the extension's custom handoff/pickup messages are
derived control projections. Native threshold compaction is suppressed while
the extension is loaded, but manual and overflow compaction remain available
and interrupt a pending handoff cleanly.

For focused tests or private diagnostics, `createAutoCompactController` accepts
an `onDebug(record)` callback and exposes `snapshot()`. Normal TUI output does
not include lifecycle IDs or raw diagnostics.
