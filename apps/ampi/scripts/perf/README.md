# AmPi perf loop

This README is the single authority for the perf loop: commands, the run lock,
fixtures, targets, and the run directory. `LIMITS` in `report.mjs` implements
the "Targets and limits" table. Keep the two in step.

## One command

From `apps/ampi`:

```sh
npm run perf -- run --fixture owner --scenario startup --repeat 10
```

Each run prepares the fixture home, starts the hub on a free port, waits for
`/api/health`, drives the scenario, stops the hub, merges the traces, and
checks the limits. The group directory is printed at the end:

```
~/.cache/ampi-perf/runs/<stamp>-<label>/
  group.json  summary.md            aggregate over the runs: pass counts, medians
  r01/ trace.json                   all processes and threads on one clock (open in ui.perfetto.dev)
       summary.md  summary.json     one screen: limits, milestones, phases, threads, spans, SQLite, functions
       receipt.json                 commit, dirty flag, node, load before/after, fixture id, args, marks
       trace-<pid>-<tid>.json  CPU.*.cpuprofile  trace-browser.json   raw inputs
```

## Commands

| Command | Does |
|---|---|
| `run --fixture owner\|synthetic --scenario startup\|switch\|idle\|index\|app [--repeat N]` | Timed runs. Default fixture `synthetic`, scenario `startup`. |
| `run … --code DIR` | Measures another checkout (repo root or its `apps/ampi`). The runner and fixture stay this checkout's. |
| `run … --no-trace` | No `AMPI_TRACE`, no `--cpu-prof`. External timings and limits only. Use it for overhead checks. |
| `run … --no-cpu-prof` | Traces without CPU sampling. |
| `run … --driver browser\|probe [--sessions K]` | Scenario driver. `browser` (default when `browser.mjs` exists) loads the page in headless Chrome. `probe` is a WebSocket client without rendering cost. K Sessions to switch, default 10. |
| `run … --label L --out DIR` | Names the group or places it. |
| `compare <A> <B>` | A and B are group or run directories. Per metric: medians, Δ, Δ %, noise, verdict. |
| `report <runDir>` | Rebuilds `trace.json` and the summaries from a run directory's raw inputs. |
| `fixture owner [--from HOME] \| synthetic` | Freezes a fixture, then fills its warm home with one cold index. |
| `lock` | Prints the lock path. |

Scenarios:

- `startup`: health, then first data, then stop.
- `switch`: `startup`, then K first-visit switches, K revisits, and 1 s idle.
- `idle`: `startup`, then 1 s idle.
- `index`: a fresh clone of the cold home. The run waits until the Host has
  loaded its index, the derive queue is empty, and no job ended for 3 s (15 s
  before the first job). It needs tracing. It is a long run outside the 10 s
  loop.
- `app`: `startup` to health, then `open -n -a` launches a separate AmPi.app
  copy (`~/.cache/ampi-perf/app/AmPiPerf.app`, bundle id
  `dev.hypercarrier.ampi.perf`) against the run's hub, as a Dock click does.
  The runner builds the copy with `macos/scripts/build-app.sh` on first use;
  delete it to rebuild. With `AMPI_TRACE` set, the app writes launch and page
  paint marks to its own trace file and skips the notification prompt. The run
  ends at the first painted Session row and quits the copy. The stats are
  milliseconds from `open`: process start, window shown, status paint, hub
  page first contentful paint, and first painted Session row. It needs tracing.
  A window appears on screen for each run.

## Run lock

Only one measured window runs at a time on this machine, across worktrees and
Teams. Builds and fixture copies stay parallel. The lock is a directory:

```
~/.cache/ampi-perf/run.lock/        (AMPI_PERF_HOME moves ~/.cache/ampi-perf)
  owner.json                        {"pid":…, "label":"…", "started":<epoch ms>}
```

The runner takes the lock once for a whole group, before its first run, and
removes it after the last run, on exit, and on SIGINT, SIGTERM, or SIGHUP.
Every timed runner, bench, or script takes the lock itself; a wrapper never
takes it for a child, and never queues runs around a held lock.

- A runner refuses to start while another holder's pid is alive, or while
  `owner.json` is missing or unreadable. `--wait` queues instead (up to 30 min).
- A lock is stale only when `owner.json` names a dead pid and stays unchanged
  for 60 s. A holder may name a child pid and release up to 60 s after that
  child exits. Only then does the next runner clear it.
- A holder removes only its own lock. Nobody removes a lock without an owner;
  clear such a lock by hand after checking that no timed run is active.

To take the lock for an external timed run from a shell:

```sh
mkdir ~/.cache/ampi-perf/run.lock || exit 1   # held: refuse
echo "{\"pid\":$$,\"label\":\"NAME\",\"started\":$(date +%s)000}" > ~/.cache/ampi-perf/run.lock/owner.tmp && mv ~/.cache/ampi-perf/run.lock/owner.tmp ~/.cache/ampi-perf/run.lock/owner.json
trap 'grep -q "\"pid\":$$," ~/.cache/ampi-perf/run.lock/owner.json && rm -rf ~/.cache/ampi-perf/run.lock' EXIT INT TERM HUP
<timed run>
```

Replace `NAME` and `<timed run>`. `$$` is the shell's pid, so a lock left by a
killed shell becomes stale.

## Host load

Each run records CPU idle over its measured window (spawn to hub exit, from
`os.cpus()` times) and the macOS memory pressure level before and after
(`kern.memorystatus_vm_pressure_level`, `memory_pressure -Q`). A run is
provisional when CPU idle is below 50 % or memory pressure is not normal, as
`apps/ampi/AGENTS.md` requires. `summary.md` flags it, and group and compare
outputs count provisional runs. Load average is context only.

## Targets and limits

The runner checks each limit that applies to the scenario. `summary.md` shows
pass, FAIL, or no data per row. The group `summary.md` shows pass counts.

| Limit (id) | Target | Scenarios | Measured as |
|---|---|---|---|
| Health answers (`health`) | < 0.5 s | startup, switch, idle | Spawn → first 200 from `/api/health`, seen by the runner (polls every 5 ms). |
| Hub listens (`hub-start`) | < 1 s | startup, switch, idle | Spawn → the hub's `listen` instant. Needs tracing. |
| Main-loop block after listen (`post-listen-block`) | < 50 ms | startup, switch, idle | Max event-loop delay on the hub main thread, over 250 ms windows that start after `listen`. Needs tracing. |
| First-visit switch p95 (`switch-first-p95`) | ≤ 50 ms | switch | p95 of the driver's `switch-done-first` durations. |
| Revisit switch p95 (`switch-revisit-p95`) | ≤ 50 ms | switch | p95 of `switch-done-revisit` durations. |
| Idle RSS, hub + workers (`idle-rss`) | ≤ 400 MB | all | `ps` RSS of the hub process (worker threads included) after the scenario. Remote agents are separate processes and are not counted. |
| Loop wall (`loop-wall`) | < 10 s | startup, switch, idle | Run setup → home preparation → spawn → scenario → stop → report, per run. A wait for the run lock is left out; `summary.md` shows it beside the wall. |
| Idle RSS after cold index (`idle-rss` on `index`) | ≤ 400 MB | index | As above, after the queue drains. Peak RSS during the index is reported beside it. |
| Cold index completes (`index-complete`) | 1 (true) | index | The derive queue drained before the 1 h timeout. |
| Cold index tail rate (`index-rate-tail`) | ≥ 0.5 | index | Jobs/s over the last 10% of derive jobs ÷ jobs/s over the first 10%. The summary shows the per-second rate curve. |

## Fixtures

Fixtures live outside Git under `~/.cache/ampi-perf/fixtures/<id>/`:

```
manifest.json        id, kind, frozenAt, copies, fill stats
sources/<n>/sessions frozen Session roots (sources/0 is the agent dir)
herdr/               replay of recorded read-only Herdr answers; other verbs fail
home-cold/           AmPi home without a working set (scenario index)
home/                AmPi home after the fill (all other scenarios)
```

- `owner` freezes the pi-local Host of an AmPi home (default
  `/tmp/ampi-startup-port-home-final`) and the Session roots in its index.
  The Host ID is pinned as `self`, because the cache directory name derives
  from it. SSH Hosts and their caches are dropped, so a run never reads live
  remote data. Index keys point at the frozen copies. Herdr answers are
  recorded once. Known gap: PTB settings are not copied, so the fixture has no
  PTB Teams.
- `synthetic` generates 40 Sessions with 200 entries each, 4 of them live.
  It is small enough for sub-second hubs and tests.

Warm runs (`startup`, `switch`, `idle`) use `home/` in place under the lock.
A clone would be cold: the transcript range reader keys its index on each
replica's absolute path and inode, so it rebuilds for every new path. The
runs therefore change `home/` a little: replicas and the working set follow
any refresh. Remake the fixture with `fixture <id>` to reset it. `index`
clones `home-cold/` to `~/.cache/ampi-perf/homes/<id>-cold` and deletes the
clone after the run.

Before each run the runner shifts the Host's recent window by the fixture's
age, so the same Sessions count as recent on every run. `hub.token` stays in
the fixture home. Reports never contain it.

## Tracing

`AMPI_TRACE=<dir>` enables `src/trace.ts` in the hub and its worker threads.
Each thread appends `trace-<pid>-<tid>.json` (Chrome Trace Event Format, Unix
epoch µs). The format and categories follow the trace contract in the perf
brief. Without `AMPI_TRACE`, each call site costs one boolean check.
`--cpu-prof` profiles use V8's clock; the report aligns each one with the
`clock-sync` spin that every traced thread runs at start.

## Reading a compare

Noise is 2 × the larger median absolute deviation (MAD) of the two sides, so
one outlier run cannot hide a shift. A delta inside the noise is `≈`. Compare groups of the same `--repeat`, run under
similar load (see `load` in each receipt).
