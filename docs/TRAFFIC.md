# Traffic analysis

Traffic analysis is an optional, read-only, loopback-only Fleet Observatory
module. It opens one of two explicit scopes: `team=piteams:<name>` for the
Team record's explicit current/historical Session mappings, or repeated
`agent=pi-session:<uuid>` values for a fixed explicit Agent list.

It reads native Pi Session history and explicit PiTeams attribution as evidence.
A Team mapping is used only when its Session file is inside the configured
trusted local Session roots; outside or symlink-escape mappings are rejected
without being read. It doesn't infer association from cwd, path, time, filename,
or prose, and it owns no Session, Agent, Membership, Task, Communication,
Project, progress, attention, or delivery truth. Source locators stay inside
local adapters and never appear in normal scope responses. A zero-readable
scope is unavailable, not an empty analysis; process-local scope and cache
state is disposable and rebuilt after restart.

## Build, start, and check health

From the repository root, build and run the foreground loopback server:

```sh
npm --workspace @hypercarrier/traffic-analysis run build
npm --workspace @hypercarrier/traffic-analysis start
```

The invoking shell owns that server; Timeline's `start:stack` owns it as a
supervised child. The server is not lazy—only scopes and caches materialize on
demand. It binds to `127.0.0.1:4321`; set `PI_TRAFFIC_PORT` before launch to
change the loopback port, then verify it:

```sh
curl --fail http://127.0.0.1:4321/health
```

For an owned background server, build first and record its exact PID:

```sh
node apps/traffic-analysis/dist/server/index.js > /tmp/hc-traffic.log 2>&1 &
echo $! > /tmp/hc-traffic.pid
```

Before stopping or restarting, inspect and stop only that process:

```sh
traffic_pid=$(cat /tmp/hc-traffic.pid)
ps -p "$traffic_pid" -o pid=,command=
kill "$traffic_pid"
rm /tmp/hc-traffic.pid
```

Do not use broad name-, Node-, or port-wide kill commands.

## Generate a scope URL

Open the Timeline link at `/traffic?team=piteams:<name>` or
`/traffic?agent=pi-session:<uuid>`. The CLI validates an explicit scope and
**prints** its URL; it does not start the server or open a browser. Start the
server first, then open the printed URL:

```sh
# Recorded Team trace example
hc-traffic open --team example-team

# Variables must hold valid explicit Pi Session UUIDs.
hc-traffic open --agent "$SESSION_UUID_A" --agent "$SESSION_UUID_B"
```

If the bin is not globally installed, build and invoke it from the workspace:

```sh
npm --workspace @hypercarrier/traffic-analysis run build
npm exec --workspace @hypercarrier/traffic-analysis -- hc-traffic open --team example-team
```

A Team scope can have four readable source mappings but three rendered Agent
lanes without error: sources are attribution inputs, while rendered Agents are
distinct Session identities. Mappings can share an identity or produce no
rendered row; inspect diagnostics and limitations rather than treating the
counts as interchangeable.

The service makes no model/provider call and has no application database. Its
default projection excludes thinking, tool payloads, raw errors, and raw source
locators. Typed resolution/source diagnostics and stale scope references are
limitations to inspect, never hidden fallbacks.

Run `node scripts/traffic-installed-canary.mjs` from the private source checkout
for the isolated generated-fixture runtime canary. Real local evidence is an
explicit operator choice, not a fixture fallback.
