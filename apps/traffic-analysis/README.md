# HyperCarrier traffic analysis

Traffic analysis is an optional, read-only, local Fleet Observatory module. It
builds a traceable Agent-turns projection from native Pi Session JSONL plus
explicit PiTeams attribution records. It is not a Task, Communication,
Membership, Project, progress, attention, or delivery authority.

## Open an explicit scope

Use the installed Timeline entries when available:

- `/traffic?team=piteams:<team-name>` resolves the Team's explicitly recorded
  current and historical teammate Session mappings.
- `/traffic?agent=pi-session:<uuid>&agent=pi-session:<uuid>` resolves a fixed,
  non-empty explicit Agent list.

Neither path accepts arbitrary source files, adds extra Agents to a Team scope,
or infers association from cwd, filename, timestamp, or prose.

The local CLI has the same selection contract:

```sh
hc-traffic open --team <safe-team-name>
hc-traffic open --agent <session-uuid> --agent <session-uuid>
```

The loopback server exposes typed, schema-versioned scope endpoints:

```sh
curl -X POST http://127.0.0.1:4321/api/traffic/scopes \
  -H 'content-type: application/json' \
  --data '{"selection":{"kind":"team_trace","teamRef":"piteams:my-team"}}'
```

Use the returned `scopeRef` for scoped matrix, event, secondary, ordinal, and
disclosure reads. References are process- and scope-bound capabilities; stale,
unknown, cross-scope, and post-restart references fail closed.

## Build, start, and check health

From the repository root, build and start the foreground loopback server. It is
owned by the invoking shell; when Timeline starts it through `start:stack`,
Timeline owns it as a supervised child. Scope and cache materialization are
lazy, but server startup is not:

```sh
npm --workspace @hypercarrier/traffic-analysis run build
npm --workspace @hypercarrier/traffic-analysis start
```

It listens only at `http://127.0.0.1:4321`; set `PI_TRAFFIC_PORT` before starting
it to choose another loopback port. In another terminal, check the exact server
origin:

```sh
curl --fail http://127.0.0.1:4321/health
```

For an owned background server, build first, then record the PID of the exact
Node process you started:

```sh
node apps/traffic-analysis/dist/server/index.js > /tmp/hc-traffic.log 2>&1 &
echo $! > /tmp/hc-traffic.pid
curl --fail http://127.0.0.1:4321/health
```

To stop or restart it, inspect that recorded PID and terminate only that process;
do not use a port-wide or name-wide kill command:

```sh
traffic_pid=$(cat /tmp/hc-traffic.pid)
ps -p "$traffic_pid" -o pid=,command=
kill "$traffic_pid"
rm /tmp/hc-traffic.pid
# Start it again with the background command above.
```

Private release maintainers can run the isolated installed-runtime canary with
`node scripts/traffic-installed-canary.mjs` from the private source checkout;
the script isn't part of the sanitized public export. It generates an empty
temporary `HOME`, synthetic Pi Session, and explicit PiTeams mapping, so it
never reads an operator's real history.

## Generate a URL

`open` validates an explicit Team or Agent-list selection and **prints** its
traffic URL. It does not start the server, open a browser, or change the
selection's evidence. Start the server first, then paste the printed URL into a
browser:

```sh
# TeamTraceScope: a recorded example Team
hc-traffic open --team example-team

# AgentListScope: variables must contain explicit valid Pi Session UUIDs.
hc-traffic open --agent "$SESSION_UUID_A" --agent "$SESSION_UUID_B"
```

If `hc-traffic` is not globally installed, build it and run its workspace bin
through npm instead:

```sh
npm --workspace @hypercarrier/traffic-analysis run build
npm exec --workspace @hypercarrier/traffic-analysis -- hc-traffic open --team example-team
```

A Team URL is a recorded Team trace, including explicit current and historical
teammate mappings. An Agent-list URL is a fixed explicit list. Neither accepts
paths or infers membership from cwd, filenames, timestamps, or prose.

A normal Team scope can resolve four readable Session sources but render three
Agent lanes. That is not by itself an error: sources are attribution inputs,
while distinct rendered Agents are Session/Agent identities; mappings can share
an identity or produce no rendered row. Read the displayed diagnostics and
scope limitation rather than treating source and rendered-Agent counts as
interchangeable.

## Trust and operating limits

Pi Session JSONL is historical evidence. A PiTeams `sessionFile` record is
explicit attribution evidence only when it is inside the configured trusted
Session roots; an outside or symlink-escape mapping is rejected without being
read. Its membership interval can be unavailable, and a Session can extend
beyond it. Session UUID is the Agent alias. A source path is an adapter-local
locator, not identity, an HTTP input, or a normal scope-response field. A scope
with zero readable explicitly selected sources is unavailable, not empty.

Prepared source and analysis caches are disposable materializations keyed by
resolved scope and source checkpoint/revision. Mapping changes rotate scope
provenance even when bytes don't change. Inactive prepared entries are bounded
by `TRAFFIC_ANALYSIS_MAX_PREPARED_SOURCES` (default `8`) and
`TRAFFIC_ANALYSIS_SOURCE_IDLE_MS` (default `300000` ms); active-scope working
set is reported separately. Restart, eviction, deletion, replacement,
truncation, malformed tails, and reappearance trigger cold replay or typed
diagnostics rather than hidden substitutions.

The browser's renderer, UTC window, selected mark, and disclosure are view
state. The projection has no model-provider cost and no application-owned
database. It exposes only policy-approved excerpts and metadata; it excludes
thinking, tool arguments/results, custom payloads, raw errors, and raw source
locators. Keep it loopback-only and use trace/debug solely to inspect local
provenance and resolution limits.

The exported Alpha bundle includes `docs/TRAFFIC.md` with the public operating
boundary. The private source's `docs/release/traffic-analysis-runbook.md` adds
cache, failure, rollback, and real-owner-use procedure.
