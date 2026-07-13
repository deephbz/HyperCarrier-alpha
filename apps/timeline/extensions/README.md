# Pi lifecycle extension

Load `timeline-lifecycle.mjs` in every Pi process. It writes metadata-only, append-only JSONL under
`~/.pi/agent/timeline/events/` by default:

```sh
pi -e /absolute/path/to/extensions/timeline-lifecycle.mjs
```

Set `PI_TIMELINE_EVENT_DIR` to override the output directory. Records separate OS process boot,
extension runtime, session attachment, agent run, and model step identities. Heartbeats are leases,
so collector code can distinguish an observed live process from a graceful stop or stale/crashed
process.

The extension deliberately never serializes prompts, messages, tool arguments, tool results, or
error text. It records tool names and categorical outcomes only. Native Pi session JSONL remains
canonical for usage and cost; the extension records context-window snapshots because request token
totals are not the same as current context occupancy.

The latest lease is also projected atomically to `~/.pi/agent/timeline/live/<process-boot-id>.json`
with mode `0600`; set `PI_TIMELINE_LIVE_DIR` to override it. This projection is disposable. The
append-only event stream remains the historical source of truth.
