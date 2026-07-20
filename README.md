# HyperCarrier Alpha

HyperCarrier is an experimental, single-user, local-first control plane for
agent-assisted work. This public Alpha combines four independently useful
parts:

- a Pi/tmux timeline and live-session dashboard;
- Rarebit, a sparse key-message projection with a Pi extension and CLI for
  derived summaries and Session-title proposals;
- a Project distiller that joins explicit Project configuration, Beads Tasks,
  Git evidence, and Rarebit summaries into append-only events and
  reviewable Markdown proposals;
- an optional read-only traffic analysis module that resolves explicit Team or
  Agent scopes from local Pi Session evidence and explicit PiTeams attribution.

The Alpha is read-only by default. It keeps runtime observations, reported
agent output, Task records, Evergreen proposals, delivery evidence, and human
attention assessment as separate axes instead of inventing one universal
Project status.

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

- `http://127.0.0.1:4318/?demo=1` for the synthetic session timeline;
- `http://127.0.0.1:4318/alpha?demo=1` for the synthetic HyperCarrier Project view.

Demo mode is explicit and never silently replaces a failed live query. It is a
client-side display mode; the local server APIs may still collect configured or
discoverable metadata. Start with an empty `HOME` if you want an isolated demo
process with no user Session files.

## Use real local data

Copy the example registry to an ignored local file and edit it for your
Projects:

```sh
cp config/project-registry.example.json config/project-registry.local.json
PI_TIMELINE_PROJECT_REGISTRY="$PWD/config/project-registry.local.json" npm start
```

Load the optional lifecycle extension in a Pi process for stronger live-state
and process/session identity evidence:

```sh
pi -e "$PWD/apps/timeline/extensions/timeline-lifecycle.mjs"
```

Rarebit is a separate Pi package under `packages/hc-rarebit`. Its model-provider
call is opt-in because selected user and assistant prose crosses the configured
provider boundary.

PiTeams orchestration and its Beads-backed Task integration are maintained in
[deephbz/pi-teams](https://github.com/deephbz/pi-teams).

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
[Alpha operation](docs/ALPHA.md), [Traffic analysis](docs/TRAFFIC.md), and
[Known limitations](docs/KNOWN-LIMITATIONS.md).

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
