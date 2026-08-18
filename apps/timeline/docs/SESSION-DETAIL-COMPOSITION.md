# Session detail composition

The Timeline link keeps its exact Session ID and opens the local Trace Viewer. Timeline remains
content-free. The viewer is the separate, authorized surface for an exact Pi Session branch.

```text
Timeline :4318 -- exact Session ID --> Trace Viewer :4319
                                           |
                                           +-- active-branch Pi JSONL -> pi-trace/1
                                           +-- raw exact JSONL download
```

## Contract

- `GET /session/:id` serves the static React Trace Viewer at the stable exact-Session URL.
- `GET /api/trace/:id` returns `pi-trace/1`: the complete current Pi active branch for a source of
  at most 16 MiB, adapted into source-identified trace records. Pi JSONL remains the evidence
  authority. It returns `413 trace_source_too_large` rather than a partial projection above that
  bound.
- Every record retains its source entry, active-branch order, readable content, raw exact-entry
  inspector payload, and unavailable Pi fields. A tool result joins only when one assistant tool
  call has the same `toolCallId`; duplicate IDs leave the link unavailable.
- The Rarebit semantic backend selects `rarebit: true` by source-entry identity. The browser filter
  is off by default and does not select the branch.
- An exact Session ID resolves only when one discovered local source declares it. Multiple sources
  return `409 ambiguous_session_source`; the service never chooses one by path order.
- `GET /raw/:id` opens a version-verified source descriptor, verifies its Session header, and
  rechecks exact Session identity before it starts the JSONL download. It has no trace-projection
  size bound and returns that version in `X-HyperCarrier-Source-Version`.
- `GET /api/events/:id` sends invalidations only. The browser refetches the complete `pi-trace/1`
  projection. It never patches an append because a new fork can replace the active branch.

For ordinary source growth, the server verifies the committed prefix digest, then incrementally
parses appended bytes. A prefix mutation, truncate, replacement, malformed completed record, or
active-branch change rebuilds the exact projection. A different Session ID at the watched path
invalidates the former route and never falls back to the replacement.

## Static build and operation

```bash
cd apps/timeline
npm run build:trace-viewer
npm run start:live
```

The static viewer shows its raw-download action when a projection is unavailable, including an
oversized source. The Trace Viewer source is under [`../trace-viewer`](../trace-viewer). It adapts
the coherent DeepSeek Harness Trajectory surface from
`deepseek-ai/deepseek-harness@99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. Its local upstream notice
retains the MIT attribution. Its dense Canvas overview and virtual ledger bound browser controls,
not the complete `pi-trace/1` evidence. The overview uses persisted active-branch order, not
invented time. Search and range focus dim records without deleting evidence. Rarebits-only is a true
scope filter and clears an out-of-scope selection.

SSE is only an invalidation hint. The browser coalesces an invalidation that arrives during a
refetch, then obtains the newest complete projection. An ordinary append retains the selected record
and scroll position, following the tail only when the operator was already there. A branch reset
clears ordinal focus and viewport state, and retains selection only when the exact record identity
remains. The viewer uses local Pi records and React text rendering; it does not import the DHS
runtime or record ontology.

All services bind to loopback. The metadata-only Timeline API does not contain trace prose, tool
payloads, raw entries, or browser inspector state.
