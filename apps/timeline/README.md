# Pi Session Timeline

Local, metadata-only monitoring for Pi sessions and OS-observed Pi processes. One OS-wide process
scan is the fleet inventory; tmux and optional Herdr 0.7.5 snapshot/process-info reads add qualified
locations, while PiTeams may add exact binding claims and separate coordination decoration. Direct
claims resolve before bounded heuristics, and every selected association states whether it is
**Provider-verified** or **Heuristic**. An unlinked process remains a first-class unbound process,
never a synthetic Session. `PI_TIMELINE_HERDR_BIN` may override the read-only Herdr binary; absence
or failure is isolated and reported only through redacted provider trace metadata.

```bash
npm test
npm run build:web
npm run quality             # format, lint, duplication, coverage, CRAP, tests, build
npm start                 # dashboard + API at http://127.0.0.1:4318
PORT=4390 npm start       # choose another local port
npm run start:stack       # timeline + live detail + TPS adapter + traffic analysis
npm run start:better-url  # http://{pi,live.pi,tps,traffic.pi}.localhost:1355
```

`PI_TIMELINE_PORT`, `PI_LIVE_DETAIL_PORT`, `PI_TPS_ADAPTER_PORT`, and `PI_TRAFFIC_PORT` configure
stack ports independently; traffic defaults to `4321`, and an ambient parent `PORT` cannot collapse
`start:stack` onto one port. `PI_TRAFFIC_BASE_URL` configures Timeline's traffic launch origin and
must be an allowlisted loopback HTTP origin; it defaults to `http://127.0.0.1:4321`. All core
services bind strictly to `127.0.0.1` and ignore `HOST`. The portless/friendly-name proxy is an
opt-in add-on rather than part of the core stack.

The better-URL mode starts the project's allowlisted HTTP proxy together with all four services. Run
`npm run start:better-url`, then use `http://pi.localhost:1355`, `http://live.pi.localhost:1355`,
`http://tps.pi.localhost:1355`, and `http://traffic.pi.localhost:1355`. Better-URL mode configures
Timeline to launch traffic through the latter origin. The proxy and every upstream bind explicitly
to `127.0.0.1`. No certificate, trusted local CA, root service, administrator authorization, DNS
edit, or LAN listener is involved. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full
dataflow and routing diagram.

Each session inspector links to two independent detail services:

- **Live session** (`:4319/session/<id>`) defaults to the complete active-branch Rarebit projection:
  persisted user messages, assistant continuations at `toolUse`, and normal assistant stops selected
  by the shared Rarebit core. It reads only appended JSONL bytes on updates and does not invoke or
  transport Pi's native export until **Full native** is selected. Full native uses the checked-in,
  checksum-verified stack-safe Pi provider automatically; its exact package/base/patch identity is
  reported by the live-detail health route. Pi's native filters remain available inside that lazy
  disclosure.
- **TPS inspector** (`:4320/?auto=1&session=<id>`) is optional and serves a separately built
  `pi-tps-web` application against that session's native JSONL.

The timeline and live-detail surfaces do not require the TPS renderer. The TPS adapter and raw
telemetry route remain healthy without it, while `/api/health` reports `renderer:false` and the
renderer route returns an actionable 404. HyperCarrier pins the external renderer contract in
`integrations/pi-tps-web.json`; build that exact artifact separately:

```bash
git clone https://github.com/monotykamary/pi-tps-web.git /path/to/pi-tps-web
git -C /path/to/pi-tps-web checkout --detach a8c99482f541acf945897b20b67cce6c2f119ee1
cd /path/to/pi-tps-web
corepack pnpm@11.6.0 install --frozen-lockfile
corepack pnpm@11.6.0 typecheck
corepack pnpm@11.6.0 test
corepack pnpm@11.6.0 build
PI_TPS_WEB_DIST="$PWD/dist" npm --prefix /path/to/HyperCarrier/apps/timeline run start:stack
```

The pinned revision declares MIT in its README and package metadata but contains no `LICENSE` file.
HyperCarrier therefore references the separately built artifact and does not vendor or redistribute
that source; re-check upstream licensing before changing the distribution model.

Refresh is event-driven: the server watches Pi session JSONL, Rarebit materializations, and PiTeams
metadata, debounces write bursts, refreshes the snapshot, and sends an SSE invalidation to browsers.
A 30-second reconciliation covers tmux/process changes that do not produce a filesystem event;
override it with `PI_TIMELINE_RECONCILIATION_MS` when debugging.

The server binds only to `127.0.0.1`; there is no LAN/public listener mode in this Alpha.

For an installed-stack fixture or canary, trusted process-local adapters may replace native
discovery roots: `PI_TIMELINE_SESSIONS_ROOT=/tmp/sessions` and `PI_TIMELINE_TEAMS_ROOT=/tmp/teams`.
Unset variables retain native `~/.pi/agent/sessions` and `~/.pi/teams` defaults. These are
launch-time collector/watcher inputs, not HTTP configuration or Timeline scope authority; use only
generated or explicitly approved local evidence roots.

Open `http://127.0.0.1:4318/?demo=1` to force a local, metadata-only stress fixture in the browser.
It contains 60 sessions and one 240-turn, 10M+ token session so dense timeline rendering can be
inspected without replacing or mixing with canonical Pi session data.

When diagnosing slowness, append `&diagnostics=1` to an existing URL (or use
`http://127.0.0.1:4318/?diagnostics=1`). This opt-in panel exposes only local operational metadata:
snapshot/session counts, collector duration and refresh reason, incremental JSONL cache counters,
and browser fetch/invalidation timing. It never exposes prompt, completion, tool, or terminal
content; copy those values into a bug report together with the relevant time window.

The Timeline offers two read-only traffic entry points. In an attributable Pi Team inspector, **Open
traffic analysis** opens `traffic?team=piteams:<team-name>`. Select explicit canonical Pi Session
UUIDs with the lane checkboxes, then **Open traffic analysis for N Agents** opens repeated
`agent=pi-session:<uuid>` parameters. These deep links are mutually exclusive, carry neither file
paths nor Timeline-owned scope state, and the traffic service resolves its own scope through its
`POST /api/traffic/scopes` boundary. The Timeline's `/api/traffic/config` reports the launch origin
and `/api/traffic/health` reports an opt-in loopback availability diagnostic.

The **Search sessions** box performs a case-insensitive partial match against session ID, session
name, and cwd. An empty or whitespace-only query leaves all sessions visible.

Grouping supports project, cwd, session name, Pi Team, current tmux session, current tmux window,
current tmux pane, and state. Pi Team correlation requires a PID from the team runtime/PID artifacts
that still maps to an observed live Pi process; configured pane IDs are retained only as provenance
because they can be stale after respawn. Historical sessions without live team/tmux evidence are
placed in explicit “No … evidence” groups rather than guessed.

The separate **Filter** and **Value** controls use the same field ontology as grouping for project,
cwd, session name, Pi Team, tmux session/window, and state. They compose with time range,
alive-only, and free-text search instead of replacing those constraints.

Live lane labels show the bound Pi session ID when conservative correlation succeeds. Current
PiTeams Membership evidence can bind exactly only when active Membership identity, runtime
generation, PID/process start, configured pane, and a unique catalog source all agree. Remaining
processes may be correlated through a unique same-cwd tmux-window/session-name match, unique
process/session start evidence, or deterministic same-second spawn batches. A resumed team lead may
be inferred only when it is the sole unmatched Pi sharing a qualified tmux window and cwd with
multiple PID-validated teammates, followed by one recent named unclaimed session. The API exposes
separate process and session binding evidence; the inspector keeps full Session identity and
owner-relevant state/usage/Summary structure in its default hierarchy, while PID, process instance,
match method/confidence, evidence source, canonical JSONL source, and Summary lineage remain
copyable in a closed diagnostic disclosure. It leaves the session ID explicitly unavailable when
evidence is ambiguous.

Lane identity typography uses only the typed live coordination role: explicit teammates are
subordinate, while team leads, standalone Sessions, and unknown coordination remain primary. The
visible compact line retains the Rarebit count and shows cumulative Session tokens and USD spend;
partial native evidence is labeled as a `known` observed subtotal and missing evidence is shown as
unavailable, never as an invented zero. Runtime state remains available through the state mark,
accessible lane name, and inspector instead of being repeated as visible text.

## Code-quality gates

- `npm run format` / `format:check`: deterministic Prettier formatting.
- `npm run lint`: ESLint, TypeScript-aware rules, React Hooks rules, cyclomatic complexity, and
  SonarJS cognitive-complexity checks.
- `npm run duplicates`: jscpd with a 3% duplication ceiling.
- `npm run coverage`: c8 for Node services/extensions and V8 coverage for Vitest.
- `npm run crap`: function-level CRAP risk using the coverage artifacts, failing above 30.
- `npm run quality`: all gates plus the full tests and production build.

Coverage and CRAP are diagnostic signals, not permission to delete behavior. Refactors must retain
the metadata/privacy contracts and pass the live API/UI verification anchors below.

`npm start` serves the production build from `dist/web`, including SPA route fallback. API paths
always retain precedence and never fall through to HTML. Static paths are decoded and root-checked,
symlinks are resolved before serving, and immutable caching is limited to fingerprinted
asset-directory files.

Timeline does not load a Pi extension or read/write Timeline lifecycle files. Every Pi process
discovered in a current tmux pane remains visible with process liveness and location, but its work
state is explicitly unavailable; Timeline does not infer thinking, tool use, idle, blocking,
completion, context occupancy, or progress.

## Current limitations

- Pi Messenger mesh history is not ingested. Pi Teams config/runtime/PID metadata is ingested only
  for currently PID-correlated members; historical team membership is not guessed.
- `/api/health` describes the latest collection pass; use `/api/trace` when diagnosing correlation,
  source counts, and freshness.
- Monitoring is metadata-only. Terminal content, prompts, tool arguments, and tool output are
  intentionally unavailable to the dashboard. The bounded exception is a content-free, fresh,
  package-owned five-status Rarebit Summary projection; it remains separate from liveness, work
  state, and timeline marks.

## Metadata API

- `GET /api/snapshot` returns schema-versioned sessions, turns, provider requests, Rarebit marker
  metadata, tri-state Rarebit Summary attention metadata, live agents, and a compact provenance
  trace. The UI fails visibly on an incompatible schema instead of treating renamed or missing
  collections as zero evidence.
- `GET /api/events` emits SSE invalidations; clients refetch the snapshot so there is only one state
  model.
- `GET /api/trace` explains tmux queries, cache hits, source counts, and correlation provenance.
- `GET /api/health` reports collector health plus the configured traffic health location.
- `GET /api/traffic/config` reports the traffic launch origin; `GET /api/traffic/health` performs a
  bounded loopback health diagnostic without making Timeline a traffic authority.

The JSONL parser only copies identity, timestamps, model/provider, stop reason, token counts, and
cost. Prompt text, assistant text, reasoning, tool arguments, tool output, terminal content, and
full process command lines never cross the API boundary.

## Live process observation

`TmuxLocation`, OS `ProcessInstance`, and Pi `ConversationSession` are separate identities. Pane IDs
are qualified by tmux server socket; process IDs are qualified by observed start time. A current Pi
process must be found through a non-dead tmux pane and process ancestry. It is then visible as
`Running` with liveness/location, while its work state remains explicitly `unobserved` with reason
`process_only_observation`. Timeline does not collect or infer lifecycle/activity state.
