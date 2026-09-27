# HyperCarrier Alpha

HyperCarrier is an experimental, single-user, local-first control plane for
agent-assisted work. This public Alpha is a source composition for technical
testing. It contains these components:

- a Pi/tmux timeline and live-session dashboard;
- Auto Compact, an opt-in Pi extension that preserves durable work before
  delegating to Pi's native context compaction;
- Rarebit, a sparse key-message projection with a Pi extension and CLI for
  derived summaries and Session-title proposals;
- System Prompt Audit, an operator-only Pi package that captures immutable JSON
  evidence and renders deterministic Markdown and HTML reviews;
- an optional read-only traffic analysis module that resolves explicit Team or
  Agent scopes from local Pi Session evidence and explicit PiTeams attribution.

## Source projection

This checkout is generated from a selected committed private source. The
exporter preserves the public allowlist, child gitlinks, package workspace
closure, and generated provenance. Read package manifests, Git metadata, npm
registry data, and the linked GitHub release for current versions and artifact
identity. This README does not duplicate volatile release tables.

The source includes typed Trace Viewer content boundaries and full-page record
inspection, import-aware Rarebit filtering in Timeline, Traffic, and TPS
projections, and the PiQ CLI composition. The observatory paths are read-only
by default. System Prompt Audit writes only explicit operator-requested local
artifacts. Auto Compact is a separately loaded control extension; it keeps its
notices distinct from Session truth and delegates actuation to Pi's native
compactor.

The Alpha keeps runtime observations, reported agent output, Task records,
delivery evidence, and human attention assessment as separate axes instead of
inventing one universal Project status.

## Quick start

Requirements:

- Node.js 22.19 or newer;
- macOS or a compatible Unix environment for live process/tmux discovery;
- optional: `pi`, `tmux`, and `bd` for real local evidence.

Install and verify from a recursive checkout:

```sh
git submodule update --init --recursive
npm ci
npm test
npm run build:timeline
npm run build:traffic
```

Start the timeline:

```sh
npm start
```

`npm run start:stack` starts Timeline, Trace Viewer, and the TPS adapter on independent loopback
ports. Friendly `.localhost` names are an optional proxy add-on. The TPS renderer is supported as
an explicitly pinned external build; follow `apps/timeline/README.md` and its
`integrations/pi-tps-web.json` contract rather than installing an unpinned latest version.

Trace Viewer is the exact-Session active-branch Pi trace surface. It serves static React over the
schema-versioned `pi-trace/1` projection, with a DeepSeek Harness Trajectory-derived overview,
ledger, exact-record inspector, raw JSONL download, and an off-by-default Rarebit filter. Pi JSONL
remains evidence authority. The local copied source retains its pinned upstream revision and MIT
notice under `apps/timeline/trace-viewer`.

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

Rarebit is the independent public `@hypercarrier/rarebit` package with the
`rarebit` CLI. HyperCarrier composes it at the stable `packages/hc-rarebit`
gitlink and owns compatibility only. Run local commands through the pinned
workspace executables:

```sh
npm exec -- piq entries --session /absolute/source.jsonl
npm exec -- rarebit fork /absolute/source.jsonl
```

Its model-provider call is opt-in because
selected user and assistant prose crosses the configured provider boundary.
When Pi runs under Herdr, Rarebit can report two optional recency clocks: latest
selected user message, then latest selected agent stop. They aren't liveness,
progress, or delivery state. The package README documents the token contract.

**Artifact identity:** use the exact package version, dist-tag, Git tag, and
GitHub release shown by the package and repository metadata. Do not infer an
artifact version from this generated checkout or replace npm provenance with a
repaired Git identity. Immutable tags and published package bytes remain
separate authorities.

## Upgrade composed Pi extensions

After updating this checkout, run `git submodule update --init --recursive`
and `npm ci`. Restart Pi to load the updated extension code. Existing external
npm installations remain separate from this checkout.

Read the pinned [Pi Team Bright upgrade guide](packages/pi-team-bright/README.md#upgrade-from-model-profiles)
before changing Worker model settings. Finish or stop live Teams on their
original version, preserve their stores and Session logs, then migrate settings
and start new Team epochs. The pinned [Rarebit guide](packages/hc-rarebit/README.md)
owns its command, settings, and Recap behavior.

## Verified terminal theme candidate

Requirements: Node.js 22.19 or newer; Python 3.11 or newer; and Herdr and
Ghostty executables on `PATH` for validation. Colorstack is a Python project, not an npm workspace.
The public selection uses `modus`.

1. Clone and verify the two source children:

```sh
git clone --recurse-submodules https://github.com/deephbz/HyperCarrier-alpha.git
cd HyperCarrier-alpha
npm ci
npm run verify:colorstack
```

The recursive checkout contains `packages/pi-team-bright` and `config/colorstack`.
A non-recursive clone must run `git submodule update --init --recursive` before
verification.

2. Compose to a new path outside this source checkout:

```sh
candidate="$HOME/Downloads/hypercarrier-modus-candidate"
npm run compose:terminal-theme -- --output-root "$candidate"
```

If verification, generation, or validation fails, the command produces no
candidate. Your color-free configuration remains usable.

3. Inspect the receipt and candidate files:

```sh
cat "$candidate/composition-receipt.json"
find "$candidate" -type f | sort
```

4. Optional operator action: copy only the files you choose, then use the
   normal operator commands to install, select, and reload them. Perform visual
   acceptance in your own terminal. The compose command does not install, select,
   or reload a live configuration.

## Optional terminal integration examples

The `config/` directory contains a portable terminal behavior/keybinding bundle:

- `herdr.example.toml` configures pane navigation, Cmd+F zoom, the role-only
  Pi Teams hierarchy row, Rarebit Status and Agent View Presets controls, and
  file-viewer shortcuts;
- `herdr.plugins.lock.toml` records complete plugin installation intent for the
  three plugins shipped in this checkout and the pinned external file viewer;
- `ghostty.example.config` combines non-color terminal settings with the macOS
  keybindings that pass those controls through.

These are examples, not a replacement for a live configuration. First install
and enable the checkout-local plugins from this checkout, then selectively merge
only the desired Herdr tables/key commands and Ghostty settings into your own
files. For the external viewer, install the exact lock revision rather than an
unpinned latest release:

```sh
herdr plugin link "$PWD/tools/agent-view-presets"
herdr plugin enable agent-view-presets
herdr plugin link "$PWD/tools/rarebit-status"
herdr plugin enable rarebit-status
herdr plugin link "$PWD/tools/pi-teams-hierarchy"
herdr plugin enable pi-teams-hierarchy
herdr plugin install --ref 96fcc0a2bdd2727ec88c38f8c8806f97b7ca0ea0 -y smarzban/herdr-file-viewer
```

Validate copies without reading or replacing your default configuration:

```sh
config_dir="$(mktemp -d)"
mkdir -p "$config_dir/herdr"
cp config/herdr.example.toml "$config_dir/herdr/config.toml"
HERDR_CONFIG_PATH="$config_dir/herdr/config.toml" herdr config check
ghostty +validate-config --config-file="$PWD/config/ghostty.example.config"
rm -rf "$config_dir"
```

The bundle deliberately excludes runtime plugin state, managed checkouts,
personal paths, generated color output, and live terminal configuration.

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

System Prompt Audit is under
[`packages/systemp-prompt-audit`](packages/systemp-prompt-audit). Its Pi command
captures the current effective prompt and active tool definitions as immutable
JSON. Its CLI verifies the payload hash and renders deterministic Markdown and
script-free HTML without a model call. Snapshots and reviews can contain local
paths and private instructions, so keep them as sensitive local artifacts.

## Optional Herdr tools

This checkout includes three Herdr plugins and one separate recovery CLI. They
require [Herdr](https://github.com/deephbz/herdr) 0.7.5 or newer. The plugins
use Node.js. `rarebit-status` also requires the verified Rarebit submodule, and
`pi-teams-hierarchy` requires the verified Pi Team Bright submodule. The
recovery CLI requires Python 3.12 or newer and
[uv](https://docs.astral.sh/uv/); it is not a Herdr plugin.

From the public checkout root, link and enable each plugin. Then verify the
records, check the merged configuration, reload Herdr, and invoke the actions:

```sh
for plugin in agent-view-presets rarebit-status pi-teams-hierarchy; do
  herdr plugin link "$PWD/tools/$plugin"
  herdr plugin enable "$plugin"
  herdr plugin list --plugin "$plugin" --json
done
herdr config check
herdr server reload-config

herdr plugin action invoke agent-view-presets.no-teammates
herdr plugin action invoke rarebit-status.open
herdr plugin action invoke pi-teams-hierarchy.refresh-all
```

The example Agent-sidebar row shows only the stable Team Membership role. The
containing tab supplies Team context, and Workers use a muted `↳` child row.
Rarebit Status and Pi Teams Hierarchy own separate metadata tokens. Agent View
Presets alone owns the optional Agent filter, so the three plugins can run
together.

Run the recovery CLI without a private-machine path:

```sh
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery doctor
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery dump
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery plan
```

`restore --execute` changes live Herdr panes, so inspect the default dry-run
plan first. Each tool README gives exact use, verification, and removal steps.

Pi Team Bright orchestration and its graph-native Task authority are maintained in
[deephbz/pi-team-bright](https://github.com/deephbz/pi-team-bright). Clone this Alpha with `git clone --recurse-submodules`; a non-recursive clone intentionally lacks `packages/pi-team-bright` until `git submodule update --init --recursive` is run. The committed gitlink and child package metadata identify the selected source and artifact independently.

## Trust model

- Native Pi Sessions, Beads, Git, tmux, and OS process observations remain the
  source evidence.
- Summaries and dashboards are derived projections, never replacements for raw
  evidence.
- Project association comes only from explicit configuration. cwd, PID, file
  name, and timestamp proximity do not silently create identity.
- A system-prompt snapshot is point-in-time local evidence. Markdown and HTML
  are deterministic review projections, not new authority.

See [Concepts](docs/CONCEPTS.md), [Architecture](docs/ARCHITECTURE.md),
[Traffic analysis](docs/TRAFFIC.md), and [Known limitations](docs/KNOWN-LIMITATIONS.md).

## Privacy and security

The services bind to `127.0.0.1` by default. Do not expose them to a LAN or the
public internet: even metadata-only APIs can reveal local paths, Project names,
Session identities, model/provider usage, cost, and tmux topology.

No real Project registry, Session log, summary, system-prompt snapshot, or
review is included in this repository. Checked-in fixtures are synthetic.

See [SECURITY.md](SECURITY.md) for the data boundary and private vulnerability
reporting guidance.

## Alpha status

This is an experimental source release for technical testing. It has no
multi-user/auth/RBAC layer, no intervention-assessment producer, and no claim
of atomic multi-writer Task updates. Expect interfaces and schemas to evolve.

Licensed under the [MIT License](LICENSE).
