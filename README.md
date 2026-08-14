# HyperCarrier Alpha

HyperCarrier is an experimental, single-user, local-first control plane for
agent-assisted work. This public Alpha combines five independently useful
parts:

- a Pi/tmux timeline and live-session dashboard;
- Auto Compact, an opt-in Pi extension that preserves durable work before
  delegating to Pi's native context compaction;
- Rarebit, a sparse key-message projection with a Pi extension and CLI for
  derived summaries and Session-title proposals;
- System Prompt Audit, an operator-only Pi package that captures immutable JSON
  evidence and renders deterministic Markdown and HTML reviews;
- an optional read-only traffic analysis module that resolves explicit Team or
  Agent scopes from local Pi Session evidence and explicit PiTeams attribution.

The observatory paths are read-only by default. System Prompt Audit writes only
explicit operator-requested local artifacts. Auto Compact is a separately
loaded control extension; it keeps its notices distinct from Session truth and
delegates actuation to Pi's native compactor. The Alpha keeps runtime
observations, reported agent output, Task records, delivery evidence, and human
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
gitlink and owns compatibility only; its model-provider call is opt-in because
selected user and assistant prose crosses the configured provider boundary.
When Pi runs under Herdr, Rarebit can report two optional recency clocks: latest
selected user message, then latest selected agent stop. They aren't liveness,
progress, or delivery state. The package README documents the token contract.

**Release tags:** use exact `@hypercarrier/rarebit@0.1.0-alpha.4` and
`@hypercarrier/pi-openai-blackmagic-compact@0.1.0-rc.7` recovery pins. Rarebit's
`next` tag points to alpha.4 while npm `latest` remains the retained
`0.1.0-alpha.1` bootstrap exception. Blackmagic's `next` tag points to rc.7
while npm `latest` remains rc.5. Blackmagic rc.7 is branch-provenance evidence:
its npm artifact, SLSA provenance, and publish workflow are verified, but no
matching Git tag or GitHub Release exists. No retained version was unpublished
or retargeted, and Alpha has not been published from this candidate.

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

- `herdr.example.toml` configures pane navigation, Cmd+F zoom, the Rarebit
  Status and Agent View Presets controls, and file-viewer shortcuts;
- `herdr.plugins.lock.toml` records complete plugin installation intent for the
  two plugins shipped in this checkout and the pinned external file viewer;
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

Three local tools are included for Herdr operators. They require [Herdr](https://github.com/deephbz/herdr) 0.7.5 or newer; the two plugins also use the Node.js runtime already required above. `agent-view-presets` reads local PiTeams membership files, and `rarebit-status` additionally requires a Pi checkout configured with this checkout's `packages/hc-rarebit` gitlink path. The recovery CLI requires Python 3.12 or newer and [uv](https://docs.astral.sh/uv/).

From the public checkout root, link and enable the plugins:

```sh
herdr plugin link "$PWD/tools/agent-view-presets"
herdr plugin enable agent-view-presets
herdr plugin action invoke agent-view-presets.no-teammates

herdr plugin link "$PWD/tools/rarebit-status"
herdr plugin enable rarebit-status
herdr plugin action invoke rarebit-status.open
```

Run the recovery CLI without a private-machine path:

```sh
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery doctor
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery dump
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery plan
```

`restore --execute` changes live Herdr panes, so inspect the default dry-run plan first. Each tool's README documents its boundary and recovery behavior.

Pi Team Bright orchestration and its graph-native Task authority are maintained in
[deephbz/pi-team-bright](https://github.com/deephbz/pi-team-bright). Clone this Alpha with `git clone --recurse-submodules`; a non-recursive clone intentionally lacks `packages/pi-team-bright` until `git submodule update --init --recursive` is run. The gitlink composes the verified `0.17.0` source revision. The compatibility record separately verifies the immutable `@hypercarrier/pi-team-bright@0.17.0` npm artifact and its public release receipts.

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
