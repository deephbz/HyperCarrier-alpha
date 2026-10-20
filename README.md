# HyperCarrier Alpha

HyperCarrier is an experimental, single-user workspace for directing Pi work
and reviewing its evidence. This Alpha is generated from one selected private
source commit for technical testing.

## Components

- [AmPi](apps/ampi/README.md) is the local GUI and hub for Pi Sessions. Its
  internal Timeline and Arcs combine session activity with evidence-backed
  summaries.
- [Trace Viewer](apps/trace-viewer/README.md) opens an exact Pi Session branch,
  shows individual records, and can download the source JSONL. Pi Session
  JSONL remains the source authority.
- [HC Control](packages/pi-hc-control/README.md) gives each Pi Session a local
  socket for owner input, abort, and status.
- The durable Team, Rarebit, and Compact packages adapt existing HyperCarrier
  behavior to pi-durable. The independent [Rarebit](packages/hc-rarebit/README.md)
  package owns sparse conversational selection and derived receipts.
- Auto Compact, Cache Goblin, and System Prompt Audit are separate Pi packages.
  See [Architecture](docs/ARCHITECTURE.md) for ownership boundaries.

AmPi is an experimental midway snapshot with live Herdr integration paths.
Full UX acceptance remains open. Arc cache, boundary, model, command, and
performance work remains open. The pi-durable node backend remains deferred.

## Install and verify

Requirements:

- Node.js 22.19 or newer;
- macOS or a compatible Unix environment for local process discovery;
- optional: Pi, Herdr, SSH, and tmux for live Session discovery and control.

Clone with its source children, then install and verify:

```sh
git clone --recurse-submodules https://github.com/deephbz/HyperCarrier-alpha.git
cd HyperCarrier-alpha
npm ci
npm test
npm run build:ampi
npm run build:trace-viewer
```

Start AmPi with `npm start`. Start Trace Viewer with
`npm run start:trace-viewer`. Each app prints its local URL. Keep the AmPi
access URL private.

The app tests use synthetic fixtures. A live receipt, successful build, or
passing test does not establish full UX acceptance.

## Source and package identity

The exporter preserves selected source files, child Git links, package
workspaces, and generated provenance. Read package manifests, Git metadata,
npm registry data, and the linked GitHub release for current artifact identity.
Do not infer a package version from this generated checkout.

## Pi packages

The independent [`@hypercarrier/rarebit`](packages/hc-rarebit/README.md)
package provides sparse conversational selection and the `rarebit` CLI. Its
optional model call can select the latest selected user message and assistant
stop. Pi JSONL remains the source authority.

[`packages/hc-auto-compact`](packages/hc-auto-compact/README.md) provides the
Auto Compact extension. Load it from this checkout:

```sh
pi -e "$PWD/packages/hc-auto-compact/src/extension.mjs"
```

Use `/auto-compact status` in Pi to inspect its settings and runtime state.
The extension delegates compaction to Pi. [`packages/pi-cache-goblin`](packages/pi-cache-goblin/README.md)
provides a separate prompt-cache policy. [`packages/systemp-prompt-audit`](packages/systemp-prompt-audit/README.md)
captures a local prompt snapshot for deterministic review.

## Terminal and local tools

The `config/` directory contains optional Herdr and Ghostty examples. It has
no runtime state or personal configuration. Follow
[`config/README.md`](config/README.md) before copying settings.

[`whereami`](tools/whereami/README.md) is a standalone Python CLI for local
host and client orientation. Its output can expose private machine data; review
it before sharing. [`tools/tpm`](tools/tpm/README.md) contains reusable
procedures for a private Markdown context store. Keep personal policy, source
inventories, results, and runtime state outside this checkout.

The optional Herdr examples and plugins require Herdr 0.7.5 or newer. The
recovery CLI requires Python 3.12 or newer and `uv`. Link the plugins from this
checkout, then inspect the merged configuration:

```sh
herdr plugin link "$PWD/tools/agent-view-presets"
herdr plugin enable agent-view-presets
herdr plugin link "$PWD/tools/rarebit-status"
herdr plugin enable rarebit-status
herdr plugin link "$PWD/tools/pi-teams-hierarchy"
herdr plugin enable pi-teams-hierarchy
herdr plugin action invoke agent-view-presets.no-teammates
herdr plugin action invoke rarebit-status.open
herdr plugin action invoke pi-teams-hierarchy.refresh-all
herdr config check
```

Run the recovery CLI:

```sh
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery doctor
```

See each tool README for its trust boundary and removal steps.

Validate copied configuration without changing your defaults:

```sh
config_dir="$(mktemp -d)"
mkdir -p "$config_dir/herdr"
cp config/herdr.example.toml "$config_dir/herdr/config.toml"
HERDR_CONFIG_PATH="$config_dir/herdr/config.toml" herdr config check
ghostty +validate-config --config-file="$PWD/config/ghostty.example.config"
rm -rf "$config_dir"
```

## Contributing

Read [Contributing](CONTRIBUTING.md), [Architecture](docs/ARCHITECTURE.md),
[Concepts](docs/CONCEPTS.md), and [Known limitations](docs/KNOWN-LIMITATIONS.md)
before proposing a change.
