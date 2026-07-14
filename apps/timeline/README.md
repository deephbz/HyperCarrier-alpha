# Pi Session Timeline

Local, metadata-only monitoring for Pi agents running in tmux. The collector discovers every tmux
server socket owned by the current user, joins pane process trees to Pi processes, incrementally
reads native Pi JSONL, and validates exact live state from the bundled lifecycle extension's leases.
It also reads `~/.pi/teams` configs, runtime records, and PID evidence to correlate live processes
with Pi Team and teammate names.

```bash
npm test
npm run build:web
npm run quality             # format, lint, duplication, coverage, CRAP, tests, build
npm start                 # dashboard + API at http://127.0.0.1:4318
PORT=4390 npm start       # choose another local port
npm run start:stack       # timeline + live detail + TPS adapter
npm run start:better-url  # http://{pi,live.pi,tps.pi}.localhost:1355
```

`PI_TIMELINE_PORT`, `PI_LIVE_DETAIL_PORT`, and `PI_TPS_ADAPTER_PORT` configure the three stack ports
independently; an ambient parent `PORT` cannot collapse `start:stack` onto one port. All core
services bind strictly to `127.0.0.1` and ignore `HOST`. The portless/friendly-name proxy is an
opt-in add-on rather than part of the core stack.

The better-URL mode starts the project's allowlisted HTTP proxy together with the three services.
Run `npm run start:better-url`, then use `http://pi.localhost:1355`,
`http://live.pi.localhost:1355`, and `http://tps.pi.localhost:1355`. The proxy and every upstream
bind explicitly to `127.0.0.1`. No certificate, trusted local CA, root service, administrator
authorization, DNS edit, or LAN listener is involved. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full dataflow and routing diagram.

Each session inspector links to two independent detail services:

- **Live session** (`:4319/session/<id>`) uses Pi's own HTML exporter and regenerates through
  filesystem events after completed assistant messages. Its added `Turns` projection defaults to
  persisted user messages plus terminal assistant messages (an assistant record whose Pi
  `stopReason` is present and isn't `toolUse`). Pi's native filters remain available to reveal tool,
  settings, and other raw entries. Same-branch updates append incrementally while preserving earlier
  DOM state; branch divergence hard-refreshes.
- **TPS inspector** (`:4320/?auto=1&session=<id>`) is optional and serves a separately built
  `pi-tps-web` application against that session's native JSONL.

The timeline, live-detail, and Alpha Project surfaces do not require the TPS renderer. The TPS
adapter and raw telemetry route remain healthy without it, while `/api/health` reports
`renderer:false` and the renderer route returns an actionable 404. HyperCarrier pins the external
renderer contract in `integrations/pi-tps-web.json`; build that exact artifact separately:

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

Refresh is event-driven: the server watches Pi session JSONL and lifecycle lease directories,
debounces write bursts, refreshes the snapshot, and sends an SSE invalidation to browsers. A
30-second reconciliation covers tmux/process changes that do not produce a filesystem event;
override it with `PI_TIMELINE_RECONCILIATION_MS` when debugging.

The server binds only to `127.0.0.1`; there is no LAN/public listener mode in this Alpha.

Open `http://127.0.0.1:4318/?demo=1` to force a local, metadata-only stress fixture in the browser.
It contains 60 sessions and one 240-turn, 10M+ token session so dense timeline rendering can be
inspected without replacing or mixing with canonical Pi session data.

When diagnosing slowness, append `&diagnostics=1` to an existing URL (or use
`http://127.0.0.1:4318/?diagnostics=1`). This opt-in panel exposes only local operational metadata:
snapshot/session counts, collector duration and refresh reason, incremental JSONL cache counters,
and browser fetch/invalidation timing. It never exposes prompt, completion, tool, or terminal
content; copy those values into a bug report together with the relevant time window.

The **Search sessions** box performs a case-insensitive partial match against session ID, session
name, and cwd. An empty or whitespace-only query leaves all sessions visible.

Grouping supports project, cwd, session name, Pi Team, current tmux session, current tmux window,
current tmux pane, and state. Pi Team correlation requires a PID from the team runtime/PID artifacts
that still maps to an observed live Pi process; configured pane IDs are retained only as provenance
because they can be stale after respawn. Historical sessions without live team/tmux evidence are
placed in explicit “No … evidence” groups rather than guessed.

The Alpha Project view reads the canonical product registry selected by
`PI_TIMELINE_PROJECT_REGISTRY` / `HC_PROJECT_REGISTRY`. In this monorepo, start from
`config/project-registry.example.json` and keep the machine-local registry outside version control.
The view consumes configured recent-output/event JSONL and distiller proposal bundle metadata
without a timeline-owned manifest or conversion step.

The separate **Filter** and **Value** controls use the same field ontology as grouping for project,
cwd, session name, Pi Team, tmux session/window, and state. They compose with time range,
alive-only, and free-text search instead of replacing those constraints.

Live lane labels show the bound Pi session ID. Exact lifecycle bindings take precedence; teammates
without the lifecycle extension can be correlated through a unique same-cwd tmux-window/session-name
match, unique process/session start evidence, or deterministic same-second spawn batches. A resumed
team lead may be inferred only when it is the sole unmatched Pi sharing a qualified tmux window and
cwd with multiple PID-validated teammates, followed by one recent named unclaimed session. The API
exposes separate process and session binding evidence; the inspector shows PID, full session ID,
match method/confidence, evidence source, and canonical JSONL source. It leaves the session ID
explicitly unavailable when evidence is ambiguous.

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

Load the bundled lifecycle extension in each Pi process to add exact live state, context-window
usage, and process/session identity:

```bash
pi -e "$PWD/extensions/timeline-lifecycle.mjs"
```

Use an absolute path when launching Pi outside this repository. Without the extension, alive Pi
processes still appear with `confidence: "process_only"`; the collector does not guess a JSONL
session identity.

## Current limitations

- Pi Messenger mesh history is not ingested. Pi Teams config/runtime/PID metadata is ingested only
  for currently PID-correlated members; historical team membership is not guessed.
- `/api/health` describes the latest collection pass; use lease age and `/api/trace` when diagnosing
  freshness.
- Monitoring is metadata-only. Terminal content, prompts, tool arguments, and tool output are
  intentionally unavailable to the dashboard.

## Metadata API

- `GET /api/snapshot` returns sessions, turns, provider requests, live agents, and a compact
  provenance trace.
- `GET /api/events` emits SSE invalidations; clients refetch the snapshot so there is only one state
  model.
- `GET /api/trace` explains tmux queries, cache hits, source counts, and every rejected/stale
  lifecycle record.
- `GET /api/health` reports collector health.

The JSONL parser only copies identity, timestamps, model/provider, stop reason, token counts, and
cost. Prompt text, assistant text, reasoning, tool arguments, tool output, terminal content, and
full process command lines never cross the API boundary.

## Live identity and leases

`TmuxLocation`, OS `ProcessInstance`, and Pi `ConversationSession` are separate identities. Pane IDs
are qualified by tmux server socket; process IDs are qualified by observed start time; a Pi process
can switch sessions. Live records must pass all of these checks:

1. lifecycle heartbeat lease is fresh;
2. PID currently exists in the process snapshot;
3. tmux server and pane still exist;
4. PID is the pane root or its descendant;
5. process start time matches when the live projection provides it.

Stale or malformed evidence is retained only as a reason in `/api/trace`.
