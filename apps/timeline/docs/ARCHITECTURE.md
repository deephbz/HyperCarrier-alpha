# Pi Session Timeline architecture

## Outcome

The application is a local, metadata-only observatory for Pi sessions. It does not replace tmux,
pi-messenger, or pi-teams, and it never exposes prompt, completion, tool argument, or tool output
content.

The default `/api/snapshot` is a 24-hour activity projection, keyed only by the latest persisted
user or assistant message timestamp. A server-owned, stat-invalidated catalog performs a bounded
JSONL header/tail scan for every known file; it fully parses only Sessions selected for the
requested page. `all` and custom ranges longer than 24 hours use opaque reverse-time cursors, so
history is progressively materialized rather than returned as one giant payload. File mtime, cwd,
and runtime heartbeat are not substitutes for historical Session activity. The tail scan preserves
raw UTF-8 bytes across chunk boundaries and has an explicit byte cap; when the cap is exhausted
before finding message evidence, activity is reported as `unknown` and excluded from time-window
claims rather than inferred from unrelated file or runtime metadata.

The web UI renders newest time at the left, while `Session ID` remains the identity throughout. Its
Intelligent projection is one group whose lanes sort by a presentation tuple (Team, member/role,
Session label, effective Project label). The fourth coordinate prefers an explicit Project label and
otherwise uses the cwd basename as a workspace label; that fallback is not Project identity or
association evidence. The lane title compactly joins only the tuple's present coordinates with `|`,
while sorting retains all four fixed slots; neither operation merges distinct Session evidence.
Process and work state remain separate. A validated process without lifecycle evidence reads
`Running · work state unavailable`; only an accepted lifecycle lease may render working/idle/tool
color. A stopped lane remains gray.

Lane geometry composes two independent metadata projections. User markers come from Rarebit
evidence, while every persisted assistant Request projects its raw `stopReason` as an outcome:
`toolUse` is a small hollow circle, `stop` is a larger solid circle, and other terminal reasons are
crosses while retaining their exact reason. Four SVG paths per lane preserve dense evidence without
one focusable DOM node per Request; Rarebit counts and summaries remain separate.

## Deployed stack and process topology

The production dashboard is deliberately small: Node.js reads local source artifacts and serves a
Vite-built React application. There is no Express, Next.js, container layer, or application
database. Native Pi JSONL and tmux/team artifacts remain canonical; the in-memory snapshot is a
rebuildable projection.

The Timeline directory is also a Pi extension package. A host may add that directory once to Pi's
`packages` setting; Pi then loads the declared lifecycle extension for new processes. This is a
deployment adapter, not a new service.

```text
~/.pi/agent/sessions/**/*.jsonl ----+
~/.pi/agent/timeline/{events,live} -+     +--> timeline Node HTTP service
~/.pi/teams/** ---------------------+---->|    snapshot/trace/SSE + React SPA
tmux sockets + list-panes ----------+     |
macOS process table ----------------+     +--> live-detail Node HTTP service
                                          |    Rarebit projection + JSONL SSE
                                          |    explicit pi --export disclosure
                                          |
                                          +--> TPS adapter Node HTTP service
                                               JSONL stream + pi-tps-web

Browser surfaces:
  main dashboard  = React + TypeScript + Vite build + CSS timeline lanes
  live detail     = shared-core Rarebits + sanitized Markdown projection
                    + lazy pinned stack-safe Pi native HTML
  TPS inspector   = React + TypeScript + DuckDB-WASM + Recharts
```

The three services are independent by design. macOS `launchd` owns the stack; `concurrently` keeps
the three child processes in one lifecycle and redirects their tagged output to the LaunchAgent
logs.

### Named local URL layer

The named proxy is an opt-in routing layer, not part of collection or rendering. A single service
accepts the conventional `PORT` variable, while a composed stack uses explicit `PI_TIMELINE_PORT`,
`PI_LIVE_DETAIL_PORT`, and `PI_TPS_ADAPTER_PORT` values that take precedence. The proxy and
upstreams all bind explicitly to `127.0.0.1`. The proxy runs as the login user on unprivileged port
1355, allows exactly three `.localhost` Host values, and uses plain HTTP. It installs neither a
local CA nor a root-owned service:

```text
Browser                                  named HTTP proxy       Node upstream
http://pi.localhost:1355 ---------------> pi -----------------> 127.0.0.1:4330
http://live.pi.localhost:1355 ----------> live.pi ------------> 127.0.0.1:4319
http://tps.pi.localhost:1355 -----------> tps.pi -------------> 127.0.0.1:4320
```

Portless was evaluated but rejected for the deployed local-only boundary: version 0.15.1 listened on
all interfaces even with LAN mode disabled. A probe to the host's LAN address with an allowed Host
header reached the dashboard. The project-owned proxy has the smaller required contract and is
externally verified to listen only on `127.0.0.1`.

The timeline emits absolute inspector links using
`PI_LIVE_DETAIL_BASE_URL=http://live.pi.localhost:1355` and
`PI_TPS_WEB_BASE_URL=http://tps.pi.localhost:1355`. LAN mode is intentionally not enabled because
live detail and TPS surfaces contain session transcript data. SSE remains end-to-end HTTP
`text/event-stream`; filesystem events invalidate the main snapshot and cause Live Detail to read
only new bytes on ordinary growth. Semantic branch changes cause a typed projection reset. Pi's full
native export is not generated or transported until the owner explicitly requests it.

## Ontology

- `Host`: one localhost machine identity and boot epoch.
- `OsProcessBoot`: host + PID + OS process start time. PID alone is reusable.
- `ExtensionRuntime`: one loaded extension lifetime; reload/session replacement can create several
  runtimes inside one OS process.
- `ConversationSession`: durable Pi JSONL header identity.
- `SessionAttachment`: validity interval relating a runtime and conversation.
- `TmuxPane`: tmux server/socket + stable pane id. A pane can outlive sessions.
- `TmuxBinding`: validity interval relating a process boot to a pane.
- `Project`: normalized cwd plus optional Git root/worktree.
- `CoordinationMembership`: typed messenger-mesh or Pi-team relation.
- `UserSubmission`: persisted user input; the user-facing turn count.
- `AgentRun`: `agent_start` through fully settled `agent_settled`.
- `ModelStep`: Pi `turn_start` through `turn_end`; tool loops produce several.
- `ProviderRequest`: one provider attempt/assistant response. It is source- qualified because
  attempts can spend without a durable assistant entry.
- `ActivityInterval`: thinking, tool, waiting, idle, or failed over wall time.
- `UsageSample`: request tokens, cache, cost, context, TPS, and timing.

Canonical ids are source-qualified raw ids, Pi session id, process boot, runtime id, and tmux pane
id qualified by server. Names, filenames, titles, and PIDs alone are attributes, not identities. The
snapshot therefore exposes `processBinding` and `sessionBinding` separately. Session matching
records method, confidence, and evidence/source provenance; synthetic `live:pid:*` lane keys are
never presented as Pi session IDs.

## State and time

```text
ProcessState = alive | exited | unknown
WorkStateAvailability = observed | unobserved
WorkState = idle | thinking | tool | waiting_input | settled | failed
```

Live state is a leased observation backed by heartbeat freshness, process start identity, and pane
existence. Graceful stop and inferred disappearance are not conflated. Events record `eventTime`,
collector `observedAt`, and optional process-monotonic time. Derived intervals carry
`confidence: exact | inferred`.

## Raw sources and data DAG

```text
Pi session JSONL -----------+
Pi lifecycle sidecars ------+--> normalize/dedupe --> snapshot + SSE --> UI
all local tmux servers ------+          |                              |
pi-messenger registry/feed -+          +--> trace diagnostics         +--> lanes
pi-teams roster/tasks ------+                                         +--> summaries
```

Raw append-only records are source of truth. Snapshots and aggregates are rebuildable materialized
views. Every normalized row carries provenance and a derivation version.

## Lifecycle envelope

The optional extension writes private append-only NDJSON under `~/.pi/agent/timeline/events/`. Each
event uses an envelope:

```ts
interface EventEnvelope<T> {
  schemaVersion: 1;
  eventId: string;
  source: { kind: string; instance: string; rawId: string; path?: string };
  eventTime: string;
  observedAt: string;
  monotonicNs?: string;
  hostId: string;
  payload: T;
}
```

Payloads include runtime start/heartbeat/stop, session attachment/name, coordination membership,
agent-run start/settle, model-step start/end, state change, context observation, and compaction
observation. Usage is not duplicated unless required for transient live display; native assistant
usage and optional TPS entries remain canonical.

## Collector and API

The collector enumerates default and named tmux sockets, runs `list-panes -a` per server, takes one
process-tree snapshot, and joins Pi descendants to panes. Extension leases are authoritative only
when PID/process-start/pane/heartbeat all validate. Without an extension, process ancestry proves a
live Pi process but JSONL session binding is explicitly heuristic or unknown.

- `GET /api/snapshot`: schema version `2`, sessions, requests and raw stop reasons, Rarebit marker
  metadata, process/work observations, live tmux state, and generation time. The frontend accepts
  only its exact projection version and renders incompatibility as an operator-visible error.
- `GET /api/events`: SSE invalidation/status stream; clients refetch snapshot.
- `GET /api/trace`: sources, checkpoints, candidates, rejection reasons, parse timing, redactions,
  and tmux diagnostics.
- `GET /api/health`: collector/source health.
- `POST /api/tmux/focus`: opt-in validated local pane navigation.

## Privacy boundary

Normalized types contain no content-bearing field. Message role/usage may be inspected, but
prompt/completion/tool content and raw error strings never cross the API. Errors use allowlisted
codes plus redacted metadata. Tests insert a secret sentinel into every content location and assert
it is absent from API, trace, logs, and fixtures.

## Aggregation rules

- UI `user turns` counts `UserSubmission`, not assistant messages/model steps.
- Activity duration uses `AgentRun`; model steps and provider requests are separate drill-down
  layers.
- Provider spend, energy-attributed cost, and inferred/effective cost are separate typed metrics and
  are never silently coalesced.
- Spend sums unique source-qualified provider attempts; durable assistant usage is the native
  fallback. Branch/all-entry scope is explicit in every summary.
- Current context occupancy is a context observation, not request input tokens.
- Heatmap intensity uses a shared visible-domain scale. Zero and missing values are visually
  distinct.

## Incremental ingestion and performance

At measured current scale (34 files, 2.4 MB), parsing is cheap. Checkpoints use device, inode, byte
offset, prefix/tail hash, and parser-contract version and handle truncation, rotation, renamed
files, inode reuse, malformed rows, and partial trailing lines. Re-ingestion is idempotent.

The collector retains hot state and serves compact metadata. A persistent SQLite index is allowed
for lease/checkpoint/restart correctness; raw files stay canonical. DuckDB/browser analytics remains
optional until measured latency justifies it. Synthetic verification covers at least 12 sessions,
200+ user submissions in dense sessions, multiple compactions, and 10M+ aggregate tokens.

## Frontend contract

One synchronized wall-clock scale runs newest-to-oldest from left to right. The default request is
the last 24 hours by latest persisted message time; 15-minute, 1-hour, 6-hour, 24-hour, all-history,
and custom windows share the same time semantics, while ranges beyond 24 hours cursor-page older
history lazily.

The lane has one fixed metadata projection rather than user-selectable detail or colour modes.
Rarebit user occurrences and independent assistant response outcomes retain their declared shapes
and roles; process/work state appears as a separate state cue. `Intelligent` is one group whose
lanes are sorted and titled by the compact Team, role/member, Session-label, effective-Project
tuple. Other grouping choices include project, cwd, session name, Pi Team, current tmux
session/window/pane, state, and none. A separate field/value filter composes with time, alive-only,
and free-text ID/name/cwd search.

Selecting one exact Session opens an inspector that requests its allowlisted Rarebit Summary sidecar
lazily. Missing, stale, selection-only, overflow, and failed derivations remain explicit. Raw
transcript and technical request/TPS detail stay in the separately linked Live Detail and TPS
surfaces instead of enlarging the fleet snapshot. Messenger-mesh grouping and lane virtualization
remain future work.

## Verification anchors

1. Costs reconcile independently against native assistant usage/TPS attempts.
2. Submissions, runs, steps, and requests reconcile independently.
3. Live processes map to pane PID trees across all discoverable tmux sockets.
4. Re-ingestion and restart reconciliation are idempotent.
5. No content sentinel crosses any metadata surface.
6. Fixtures cover stale/crash, reload/session switch, resume in another pane, retry/branch spend,
   malformed logs, and messenger/team membership.
7. Synthetic 10M-token fixtures meet measured correctness/performance budgets.
8. Chrome review verifies timeline legibility, filters, zoom, grouping, responsive layout, keyboard
   focus, contrast, and empty/error/live states.
9. `npm run quality` anchors formatting, static analysis, duplication, coverage, function-level CRAP
   risk, the full test suite, and the production build in one reproducible command.
