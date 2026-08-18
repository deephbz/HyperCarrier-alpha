# Pi Session Timeline architecture

## Outcome

The application is a local, metadata-only observatory for historical Pi Sessions and live
process-birth-qualified ProcessObservations. It does not replace tmux, Herdr, pi-messenger, or
pi-teams, and it never exposes prompt, completion, tool argument, terminal payload, stderr, or tool
output content. The OS process scan is primary; tmux and Herdr are optional location/direct-claim
providers, while Timeline consumes PiTeams' bounded read-only `pi-teams-observation/1` projector
instead of its private files. Recorded PiTeams Process/readiness evidence is never liveness;
Timeline independently verifies OS Process birth and terminal placement. PiTeams exact claims stay
separate from coordination decoration, and the resolver applies fresh agreeing direct claims before
recomputed bounded heuristics. A terminal-scoped Herdr Session path may locate every descendant
Process but becomes a direct claim only when exactly one observed Pi Process is in that pane;
ambiguity remains lane-local and unlinked. Direct provider conflict also remains unlinked.

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
while sorting retains all four fixed slots; neither operation merges distinct Session evidence. An
explicit Pi Team `teammate` role uses smaller, lighter typography, while an explicit lead, a
standalone Session, and unknown coordination retain the primary treatment. Process and work state
remain separate. A validated process reads `Running · work state unavailable` to assistive
technology and the inspector. Timeline does not collect or infer working/idle/tool state. The
visible compact line does not repeat runtime text because the state mark already carries that visual
signal. A historical lane without an associated Process observation remains gray but is not called
stopped.

Lane geometry composes two independent metadata projections. User markers come from Rarebit
evidence, while every persisted assistant Request projects its raw `stopReason` as an outcome:
`toolUse` is a small hollow circle, `stop` is a larger solid circle, and other terminal reasons are
crosses while retaining their exact reason. Four SVG paths per lane preserve dense evidence without
one focusable DOM node per Request. Rarebit Summary prose remains lazy, while a fresh explicit the
package-owned v4 current Summary projection may add a content-free lane annotation; only verified,
non-source-pending `needs_attention` is salient; absent, historical, stale, or unavailable values
remain unknown and never alter runtime or marker semantics.

## Deployed stack and process topology

The production dashboard is deliberately small: Node.js reads local source artifacts and serves a
Vite-built React application. There is no Express, Next.js, container layer, or application
database. Native Pi JSONL, OS observations, and producer-owned PiTeams records remain authoritative;
the in-memory snapshot is a rebuildable projection. Timeline never opens PiTeams' private storage.

```text
~/.pi/agent/sessions/**/*.jsonl ----+
~/.pi/agent/rarebit/materializations-v4+->|    snapshot/trace/SSE + React SPA
pi-teams/observation ---------------+
tmux sockets + list-panes ----------+     |
macOS process table ----------------+     +--> Trace Viewer Node HTTP service
                                          |    pi-trace/1 projection + JSONL SSE invalidation
                                          |    static React dense overview, virtual ledger, and inspector
                                          |
                                          +--> TPS adapter Node HTTP service
                                               JSONL stream + pi-tps-web

Browser surfaces:
  main dashboard  = React + TypeScript + Vite build + CSS timeline lanes
  Trace Viewer    = full active-branch Pi trace + dense/virtual presentation
                    + off-by-default Rarebit filter, raw exact-entry inspector,
                    + and JSONL download
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
Trace Viewer and TPS surfaces contain Session transcript data. SSE remains end-to-end HTTP
`text/event-stream`; filesystem events invalidate the main snapshot and the exact Trace Viewer
projection. The viewer reads only new bytes on ordinary growth, then coalesces invalidations into a
complete active-branch refetch because an appended fork can replace that branch. Its Canvas and
virtual-ledger bounds limit browser controls, not the exact projection.

## Ontology

- `Host`: one localhost machine identity and boot epoch.
- `OsProcessBoot`: host + PID + OS process start time. PID alone is reusable.
- `ConversationSession`: durable Pi JSONL header identity.
- `TmuxPane`: tmux server/socket + stable pane id. A pane can outlive sessions.
- `TmuxBinding`: validity interval relating a process boot to a pane.
- `Project`: normalized cwd plus optional Git root/worktree.
- `CoordinationMembership`: typed messenger-mesh or Pi-team relation.
- `UserSubmission`: persisted user input; the user-facing turn count.
- `ProviderRequest`: one provider attempt/assistant response. It is source- qualified because
  attempts can spend without a durable assistant entry.
- `UsageSample`: request tokens, cache, cost, context, TPS, and timing.
- `SessionUsageMetric`: a cumulative token or provider-spend projection whose availability is
  `complete`, a `partial` observed subtotal, or `unavailable`; observed zero is not absence.

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

Live observation is process-only: current Pi process ancestry proves liveness/location, while work
state remains explicitly unavailable. Process disappearance is not a work conclusion.

## Raw sources and data DAG

```text
Pi Session JSONL -------------------+
all local tmux servers --------------+          |                    |
OS Process observations -------------+          +--> trace           +--> lanes
PiTeams observation/1 projection ----+                               +--> summaries
```

Each producer's raw records remain its source of truth. Timeline receives only PiTeams' versioned,
read-only Membership-evidence projection; snapshots and aggregates are rebuildable materialized
views. Every normalized row carries provenance and a derivation version.

## Collector and API

The collector enumerates default and named tmux sockets, runs `list-panes -a` per server, takes one
process-tree snapshot, and joins Pi descendants to panes. It then awaits the optional PiTeams public
projector under its total deadline and cancellation contract. `partial` retains completed Teams;
`unavailable` removes no native Session or OS Process lane. Process ancestry proves a live Pi
process but not work state. JSONL Session binding is exact only through current PiTeams evidence
whose recorded PID/start, typed terminal target, and exact native Session locator also match
Timeline's independent observations; native correlation is explicitly inferred or unknown.

- `GET /api/snapshot`: schema version `4`, sessions with independently qualified cumulative token
  and provider-spend metrics, requests and raw stop reasons, Rarebit marker metadata, the tri-state
  content-free Rarebit Summary attention projection, process/work observations, live tmux state, and
  generation time. The frontend accepts only its exact projection version and renders
  incompatibility as an operator-visible error.
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
- Session tokens are complete when native `totalTokens` is observed or all four token components are
  present. Token components without a complete total form a partial observed subtotal. Provider cost
  is complete only when native `cost.total` is observed; component-only cost always remains a
  partial observed subtotal even when every currently known component is present. Missing request
  evidence makes an otherwise observed Session sum partial, and no observed values makes that metric
  unavailable.
- Current context occupancy is a context observation, not request input tokens.
- Heatmap intensity uses a shared visible-domain scale. Zero and missing values are visually
  distinct.

## Incremental ingestion and performance

At measured current scale (34 files, 2.4 MB), parsing is cheap. Checkpoints use device, inode, byte
offset, prefix/tail hash, and parser-contract version and handle truncation, rotation, renamed
files, inode reuse, malformed rows, and partial trailing lines. Re-ingestion is idempotent.

The collector retains hot state and serves compact metadata. A persistent SQLite index is allowed
for checkpoint/restart correctness; raw files stay canonical. DuckDB/browser analytics remains
optional until measured latency justifies it. Synthetic verification covers at least 12 sessions,
200+ user submissions in dense sessions, multiple compactions, and 10M+ aggregate tokens.

## Frontend contract

One synchronized wall-clock scale runs newest-to-oldest from left to right. The default request is
the last 24 hours by latest persisted message time; 15-minute, 1-hour, 6-hour, 24-hour, all-history,
and custom windows share the same time semantics, while ranges beyond 24 hours cursor-page older
history lazily.

The lane has one fixed metadata projection rather than user-selectable detail or colour modes.
Rarebit user occurrences and independent assistant response outcomes retain their declared shapes
and roles; process/work state appears as a separate state cue and accessible name rather than
duplicated visible text. A fresh explicit true Rarebit Summary assessment adds a compact labelled
diamond immediately before the independent liveness dot in the left-side status cluster, not on the
time track; false and unknown render no icon but keep the reserved slot so dense lane identity
remains aligned, while their data states stay distinct in the snapshot. `Intelligent` is one group
whose lanes are sorted and titled by the compact Team, role/member, Session-label, effective-Project
tuple. Only the typed `teammate` coordination role is visually subordinate. The compact line retains
the Rarebit count and adds cumulative Session tokens and USD spend using compact established units:
`known` prefixes a partial observed subtotal without turning rounded display into a bound, and `—`
marks unavailable evidence. Other grouping choices include project, cwd, session name, Pi Team,
current tmux session/window/pane, state, and none. A separate field/value filter composes with time,
alive-only, and free-text ID/name/cwd search.

Selecting one exact Session opens an inspector that requests its allowlisted Rarebit Summary sidecar
lazily. Its default owner projection orders canonical Session context and copyable identity,
independent process/work/attention state, times and usage, then the four labelled Summary sections.
Missing, legacy, stale, selection-only, overflow, and failed derivations remain explicit. Process
joins, source paths, confidence/evidence, tmux coordinates, and Summary materialization/model/job/
selection lineage remain copyable under a collapsed diagnostic/provenance disclosure; a changed
Summary job between the fleet snapshot and selected detail is called out instead of silently joining
them. Raw transcript and technical request/TPS detail stay in the separately linked Trace Viewer and
TPS surfaces instead of enlarging the fleet snapshot. Messenger-mesh grouping and lane
virtualization remain future work.

## Verification anchors

1. Costs reconcile independently against native assistant usage/TPS attempts.
2. Submissions, runs, steps, and requests reconcile independently.
3. Live processes map to pane PID trees across all discoverable tmux sockets.
4. Re-ingestion and restart reconciliation are idempotent.
5. No content sentinel crosses any metadata surface.
6. Fixtures cover Session parsing/cache behavior, resume in another pane, retry/branch spend,
   malformed logs, and Team membership.
7. Synthetic 10M-token fixtures meet measured correctness/performance budgets.
8. Chrome review verifies timeline legibility, filters, zoom, grouping, responsive layout, keyboard
   focus, contrast, and empty/error/live states.
9. `npm run quality` anchors formatting, static analysis, duplication, coverage, function-level CRAP
   risk, the full test suite, and the production build in one reproducible command.
