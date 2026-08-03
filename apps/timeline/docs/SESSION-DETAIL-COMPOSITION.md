# Session detail composition

The local stack is three narrow services joined by stable Pi session identity. No service imports
another service's product logic.

```text
timeline :4318 --links by session id--> live detail :4319 --Rarebit core--> sparse live detail
                                                   |
                                                   +--explicit request--> pi --export--> native HTML
         |
         +---------------------------> TPS adapter :4320 --> pi-tps-web dist
                                               |
                                               +--> native session JSONL
```

## Contracts

- Timeline owns discovery, aggregation and navigation. Each `Session` carries `links.live` and
  `links.tps`; base URLs are configurable with `PI_LIVE_DETAIL_BASE_URL` and `PI_TPS_WEB_BASE_URL`.
- Live detail owns exact-Session detail access. `GET /session/:id` is a stable, standalone Rarebit
  view: it resolves the complete active branch with `@hypercarrier/rarebit` (CLI: `rarebit`) at the
  stable `packages/hc-rarebit` gitlink, transports only user, agent-continuation, and normal
  agent-stop Rarebit occurrences, and does not invoke or embed Pi's exporter. The page reports how
  many other entry records remain unloaded. Its JSONL reader retains a partial tail, reads only
  bytes after the committed offset on ordinary growth, and rebuilds after truncate, replace, or
  semantic branch reset. SSE distinguishes occurrence append, selection reset, and explicit
  unavailable state. Raw Rarebit text remains the evidence field; presentation renders
  GitHub-flavored Markdown through pinned `marked` and `sanitize-html` dependencies, escapes raw
  HTML, strips active content and unsafe URL schemes, and marks links `noopener noreferrer`.

  Public release users should select exact alpha.4 or `@next`; an unpinned/latest install selects
  the `0.1.0-alpha.1` bootstrap exception. No retained version was changed, unpublished, or
  retargeted.

- `GET /render/:id` is the explicit **Load full native trace** boundary. Only that request generates
  and serves Pi's current native HTML export, whose own filters remain unchanged. The private HTML
  cache is mode `0600` and keyed in-process by exact source stat identity plus the declared exporter
  executable, revision, and capability; it is not reused by or embedded into the default Rarebit
  response. A complete Full Trace deployment selects a pinned stack-safe exporter, which bypasses
  any semantic depth ceiling. When an old recursive exporter is deliberately selected, Live Detail
  iteratively records entry count and maximum parent depth and returns an explicit compatibility
  diagnostic for a known unsafe shape; that diagnostic is not a delivered full trace. Export output
  must be a nonempty regular file before atomic rename; failed temporary output is removed.
- TPS adapter owns the session-to-renderer bridge. It serves the independently built `pi-tps-web`
  and its expected `/api/telemetry`, `/api/version`, and `/api/events` contract, selected by
  `?session=<id>`. `pi-tps-web` continues to own telemetry parsing, DuckDB queries and
  visualization.

All services bind to loopback by default. The timeline API remains metadata-only; Rarebit prose
crosses the selected live-detail port by default, while full native or raw content crosses it only
after an explicit request. Full conversation content also crosses the explicitly selected TPS detail
port. There is no upload, cloud persistence, messaging, or agent control.

## Operation

Build both frontends, then run services independently or together:

```bash
cd ../pi-tps-web && npm run build
cd ../pi-session-timeline && npm run build:web

npm run start:timeline  # 4318
npm run start:live      # 4319
npm run start:tps       # 4320

# Convenience composition; still three separate processes
npm run start:stack
```

Normal installs select the checksum-verified repo-local stack-safe Pi provider automatically. Its
absolute installed package path, release base, public patch revision, capability, and artifact
checksum are visible from `GET /api/health`; the provider manifest and MIT notice live under
`vendor/pi-exporter`.

For provider development only, override all three identity fields. The executable must be an
existing absolute executable path. The revision remains part of the private native-HTML cache
identity:

```bash
PI_LIVE_DETAIL_EXPORTER=/absolute/path/to/pinned/pi \
PI_LIVE_DETAIL_EXPORTER_REVISION=<package-or-commit-revision> \
PI_LIVE_DETAIL_EXPORTER_CAPABILITY=stack-safe \
npm run start:live
```

`PI_LIVE_DETAIL_EXPORTER_CAPABILITY` accepts only `stack-safe` or `legacy-recursive`. A configured
executable without an explicit revision and capability is rejected at startup.

Until Pi ships the iterative exporter fix, HyperCarrier packages one checksum-locked build of the
narrow public Pi patch over the exact 0.80.10 release package; downstream users don't patch or
configure their global Pi installation. This is a temporary compatibility measure, not a transfer of
native-export authority into Live Detail or Rarebit. Once an upstream Pi release passes the same
deep-tree, exact-entry, and provider-provenance suite, HyperCarrier will repin to that release and
remove the temporary patch and artifact without changing the Live Detail interface.

The timeline may run on another port without changing detail links. In a composed stack, use
`PI_TIMELINE_PORT`, `PI_LIVE_DETAIL_PORT`, and `PI_TPS_ADAPTER_PORT`; those explicit service ports
take precedence over an inherited `PORT`. If the public base URLs differ, set the corresponding base
URL variables before starting the timeline.
