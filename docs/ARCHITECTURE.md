# Architecture

HyperCarrier Alpha contains two applications. AmPi supports active Pi work.
Trace Viewer inspects one Pi Session branch. Shared packages connect these
applications to Pi while preserving source evidence.

```text
Pi Session JSONL ──► Trace Viewer local parser ──► Trace Viewer
        │                                         /view-trace
        └──► trace-analytics reader ──► AmPi hub ──► AmPi GUI
                                             │
                                             ├── HC Control socket
                                             └── durable Team, Rarebit, and Compact packages

Pi Team Bright graph ──► Team package ──► derived AmPi views
Rarebit package ───────────────────────► derived summaries and selection
```

## Authority

- Pi Session JSONL is the source evidence for transcript content.
- Pi owns the live Session and the effect of submitted input.
- HC Control provides a local socket to submit input, abort, and read status.
  Its acknowledgements describe observed Pi evidence.
- AmPi renders bounded views and summaries. A view does not replace source
  records.
- Trace Viewer reads one exact Session branch with its local parser and offers
  the corresponding source JSONL for download. Consolidation onto
  `trace-analytics` remains deferred.
- Pi Team Bright owns Team and Task graph state. The durable Team package
  adapts those semantics for AmPi.
- Rarebit selects conversational evidence and writes derived Summary and Title
  receipts outside native history.

## Components

### AmPi

AmPi is a local GUI and hub for Pi Sessions. Its Timeline and Arc views show
bounded session activity and derived summaries. It uses HC Control for a
per-Session socket and pi-durable packages for experimental Team, Rarebit, and
Compact behavior. The pi-durable node backend remains deferred.

AmPi is an experimental midway snapshot with live Herdr integration paths.
Full UX acceptance remains open. Arc cache, boundary, model, command, and
performance work remains open.

### Trace Viewer

`@hypercarrier/trace-viewer` serves an exact-session Pi trace view and the
`/view-trace` command. It shows the active branch, record content, and source
JSONL download. The AmPi reader uses `trace-analytics` for Pi record parsing
and bounded range access. Trace Viewer keeps a local parser while reader
consolidation remains deferred. It does not write to Session history.

## Supporting packages

- HC Control owns the local Session socket and evidence-backed acknowledgments.
- `@hypercarrier/pi-team-durable` adapts Pi Team Bright Task graph semantics to
  pi-durable.
- `@hypercarrier/rarebit-durable` uses Rarebit selection on durable entries.
- `@hypercarrier/auto-compact-durable` maps the Auto Compact budget and summary to
  pi-durable.
- Auto Compact, Cache Goblin, and System Prompt Audit remain independent Pi
  packages.
- Pi Team Bright and Rarebit remain independent package authorities.

## Distribution and exposure

This checkout is generated from selected committed source. The export manifest
owns the file allowlist and child Git links. The generated provenance records
the selected source revision and package closure.

The applications bind to loopback. Keep local access URLs and source Session
files private. Review derived output before sharing it.
