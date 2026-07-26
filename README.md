# HyperCarrier Alpha

HyperCarrier is an experimental, single-user, local-first control plane for
agent-assisted work. This public Alpha combines five independently useful
parts:

- a Pi/tmux timeline and live-session dashboard;
- Auto Compact, an opt-in Pi extension that preserves durable work before
  delegating to Pi's native context compaction;
- Rarebit, a sparse key-message projection with a Pi extension and CLI for
  derived summaries and Session-title proposals;
- a Project distiller that joins explicit Project configuration, Beads Tasks,
  Git evidence, and Rarebit summaries into append-only events and
  reviewable Markdown proposals;
- an optional read-only traffic analysis module that resolves explicit Team or
  Agent scopes from local Pi Session evidence and explicit PiTeams attribution.

The observatory and distiller paths are read-only by default. Auto Compact is a
separately loaded control extension; it keeps its notices distinct from Session
truth and delegates actuation to Pi's native compactor. The Alpha keeps runtime
observations, reported agent output, Task records, Evergreen proposals,
delivery evidence, and human attention assessment as separate axes instead of
inventing one universal Project status.

## Quick start

Requirements:

- Node.js 22.19 or newer;
- macOS or a compatible Unix environment for live process/tmux discovery;
- optional: `pi`, `tmux`, and `bd` for real local evidence.

Install and verify:

```sh
npm ci
npm test
npm run build:timeline
npm run build:traffic
```

Start the timeline:

```sh
npm start
```

`npm run start:stack` starts Timeline, live detail, and the TPS adapter on independent loopback
ports. Friendly `.localhost` names are an optional proxy add-on. The TPS renderer is supported as
an explicitly pinned external build; follow `apps/timeline/README.md` and its
`integrations/pi-tps-web.json` contract rather than installing an unpinned latest version.

Live Detail is Rarebit-first: its default exact-Session page transfers only the shared-core
active-branch Rarebit messages and incrementally reads appended JSONL. **Full native** lazily uses
the checked-in checksum-verified stack-safe Pi provider; users don't need to patch or configure a
global Pi installation. The provider's release base, public patch revision, MIT notice, artifact
integrity, and removal condition are under `vendor/pi-exporter` and reported by the live-detail
health route.

Then open:

- `http://127.0.0.1:4318/?demo=1` for the synthetic session timeline.

Demo mode is explicit and never silently replaces a failed live query. It is a
client-side display mode; the local server APIs may still collect configured or
discoverable metadata. Start with an empty `HOME` if you want an isolated demo
process with no user Session files.

## Use real local data

Timeline loads no Pi extension. It discovers live Pi processes through tmux and
the operating system, shows liveness/location with explicitly unavailable work
state, and keeps Session correlation conservative; an ambiguous binding remains
unavailable.

Rarebit is a separate Pi package under `packages/hc-rarebit`. Its model-provider
call is opt-in because selected user and assistant prose crosses the configured
provider boundary. When Pi runs under Herdr, Rarebit can report two optional
recency clocks: latest selected owner message, then latest selected agent stop.
They aren't liveness, progress, or delivery state. The package README documents
the token contract, and [`config/herdr.example.toml`](config/herdr.example.toml)
shows the corresponding Herdr sidebar row.

Auto Compact is a separate Pi extension under
[`packages/hc-auto-compact`](packages/hc-auto-compact). After `npm ci`, load it
directly from this checkout:

```sh
pi -e "$PWD/packages/hc-auto-compact/src/extension.mjs"
```

Use `/auto-compact status` inside Pi to inspect its effective configuration and
runtime state. Once loaded, it is enabled by default at a 90% effective-context
threshold. Its package README documents the cooperative handoff, durable
settings, manual trigger, and failure behavior.

Pi Team Bright orchestration and its Beads-backed Task integration are maintained in
[deephbz/pi-team-bright](https://github.com/deephbz/pi-team-bright). Clone this Alpha with `git clone --recurse-submodules`; a non-recursive clone intentionally lacks `packages/pi-team-bright` until `git submodule update --init --recursive` is run. The gitlink composes public source at its verified revision; `@hypercarrier/pi-team-bright` remains unpublished on npm.

## Trust model

- Native Pi Sessions, Beads, Git, tmux, and OS process observations remain the
  source evidence.
- Summaries and dashboards are derived projections, never replacements for raw
  evidence.
- Project association comes only from explicit configuration. cwd, PID, file
  name, and timestamp proximity do not silently create identity.
- The distiller writes append-only events and proposal bundles. It never
  overwrites canonical Evergreen Markdown.
- `citationStatus: exact` means referenced input event IDs are valid. It does
  not prove that model-generated claims are true or accepted.

See [Concepts](docs/CONCEPTS.md), [Architecture](docs/ARCHITECTURE.md),
[Traffic analysis](docs/TRAFFIC.md), and [Known limitations](docs/KNOWN-LIMITATIONS.md).

## Privacy and security

The services bind to `127.0.0.1` by default. Do not expose them to a LAN or the
public internet: even metadata-only APIs can reveal local paths, Project names,
Session identities, model/provider usage, cost, and tmux topology.

No real Project registry, Session log, summary, event stream, or proposal is
included in this repository. Checked-in fixtures are synthetic.

See [SECURITY.md](SECURITY.md) for the data boundary and private vulnerability
reporting guidance.

## Alpha status

This is an experimental source release for technical testing. It has no
multi-user/auth/RBAC layer, no intervention-assessment producer, and no claim
of atomic multi-writer Task updates. Expect interfaces and schemas to evolve.

Licensed under the [MIT License](LICENSE).
