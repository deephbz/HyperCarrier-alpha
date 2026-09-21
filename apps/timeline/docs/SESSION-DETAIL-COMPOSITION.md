# Session detail composition

The Timeline link keeps its exact Session ID and opens the local Trace Viewer. Timeline remains
content-free. The viewer is the separate, authorized surface for an exact Pi Session branch. The
app-owned Pi `/view-trace` command opens that same route for the invoking Session. It does not infer
Session identity from a pane, cwd, or title and does not start model work.

```text
Timeline :4318 -- exact Session ID --> Trace Viewer :4319
                                           |
                                           +-- active-branch Pi JSONL -> pi-trace/2
                                           +-- raw exact JSONL download
```

## Contract

- `GET /session/:id` serves the static React Trace Viewer at the stable exact-Session URL.
- `GET /api/trace/:id` returns `pi-trace/2`: the complete current Pi active branch for a source of
  at most 16 MiB, adapted into source-identified trace records. Pi JSONL remains the evidence
  authority. It returns `413 trace_source_too_large` rather than a partial projection above that
  bound.
- Every record retains its source entry, active-branch order, ordered typed content blocks, raw
  exact-entry inspector payload, and unavailable Pi fields. Content blocks retain their source
  index. Prose, reasoning, and tool calls never concatenate into one display string. Unsupported
  blocks remain explicit and recoverable through the raw record. A tool result joins only when one
  assistant tool call has the same `toolCallId`; duplicate IDs leave the link unavailable.
- The Rarebit semantic backend selects `rarebit: true` by source-entry identity. Rarebit focus
  starts enabled and does not select the branch. It fades non-Rarebit marks and rows without
  removing records. Overview pointer and keyboard selection excludes non-Rarebits; faded ledger rows
  remain intentionally inspectable.
- An exact Session ID resolves only when one discovered local source declares it. Multiple sources
  return `409 ambiguous_session_source`; the service never chooses one by path order.
- `GET /raw/:id` opens a version-verified source descriptor, verifies its Session header, and
  rechecks exact Session identity before it starts the JSONL download. It has no trace-projection
  size bound and returns that version in `X-HyperCarrier-Source-Version`.
- `GET /api/events/:id` sends invalidations only. The browser refetches the complete `pi-trace/2`
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
not the complete `pi-trace/2` evidence. The overview uses persisted active-branch order, not
invented time. Search, range focus, and Rarebit focus dim records without deleting evidence. Rarebit
focus changes overview selection eligibility, not ledger inspection or source scope. Pointer hit
testing follows the drawn ordinal cells, including dense pixel buckets; keyboard navigation follows
source order and skips ineligible marks.

The lower desktop workspace starts at 30:70 ledger-to-inspector width. Its separator uses available
workspace width, not a fixed maximum inspector width, so dragging can cross the midpoint. Keyboard
resizing uses the same bounds. Narrow screens stack the panes to keep both readable, and an empty
selection does not remove the desktop resize control. The Exact record header can expand the
inspector to fill the page. The same control or Escape restores the split layout. Expansion retains
the selected record, inspector view, disclosures, split width, and ledger position; background
controls and resizing stay unavailable while expanded.

SSE is only an invalidation hint. The browser coalesces an invalidation that arrives during a
refetch, then obtains the newest complete projection. An ordinary append retains the selected record
and scroll position, following the tail only when the operator was already there. A branch reset
clears ordinal focus and viewport state, and retains selection only when the exact record identity
remains. The viewer uses local Pi records; it does not import the DHS runtime or record ontology.

The inspector starts on Content in rendered mode. Prose stays expanded; reasoning and tool calls use
labeled, closed disclosures. Rendered and Raw text modes preserve those block boundaries. Search
derives text from typed content independently of display state. The Raw record tab preserves its
exact JSON payload. Marked supplies Markdown tokens for safe React rendering. Mermaid loads only for
selected diagram fences and produces sanitized Blob-backed SVG images; their CSS cannot affect the
viewer. Raw Mermaid source remains available, and diagram or image-load failure shows a local
raw-source fallback. A Content Security Policy applies before rendering and blocks external
resources, active markup, frames, and form submission. It preserves same-origin module loading and
trace refetch/SSE. No renderer becomes evidence authority.

All services bind to loopback. The metadata-only Timeline API does not contain trace prose, tool
payloads, raw entries, or browser inspector state.
