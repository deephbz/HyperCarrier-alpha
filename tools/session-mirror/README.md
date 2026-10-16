# Session mirror web IDE

Read, search and steer local and remote Pi Sessions at one browser address.
Each Host has its own transport, cache, indexes, reconnect backoff and status.
Cached reading and search need no remote round trip. This tool is in
consolidation. Its HTTP API remains unstable.

Scope: the hub (`mirror.mjs`), inline remote agent (`remote-agent.cjs`) and web
IDE (`ide.html`). Experimental TUI and native clients stay under
`experiments/local-mirror-prototype/` in private HC.

## Run

Use Node.js 22 or later on both hosts and an SSH target that can run Node.js.
Herdr supplies live agent discovery and control on the target. Without Herdr,
the remote agent lists recently modified Pi Session files with unknown status.
The local hub serves `marked` from the installed Pi release. For another Pi
layout, pass `--pi-modules /path/to/node_modules` with `marked` installed there.
Without that asset the hub still starts; `/vendor/marked.js` returns 503 with
the flag needed to configure it.

```sh
# Select local plus one saved machine or SSH target.
node tools/session-mirror/mirror.mjs --host local --host my-server
# Local test with simulated one-way delay:
node tools/session-mirror/mirror.mjs --host local --delay-ms 150
# Open http://127.0.0.1:7777/
```

Options: see the `mirror.mjs` header. `--port` and `--cache-dir` isolate a test
hub. `--teams off` disables optional Pi Team Bright labels. The target needs no
mirror installation. The hub sends one inline remote agent per Host.

With no `--host`, the hub selects local plus every enabled Herdr saved machine.
Configure machines with `herdr machine`; the hub reads its JSON registry once at
startup. Repeated `--host` overrides that set. A saved label or ID keeps its SSH
target and named Herdr session. A raw SSH target uses the default session.
Without the local Herdr CLI, local still works and explicit `--host` selects
remote targets. Registry warnings and the snapshot time appear in the sidebar.
Restart the hub to apply registry edits. Pass `--host` flags to select a subset
of saved machines. Each selected Host runs its own remote agent and cache.

SSH uses noninteractive authentication. A failed saved Host shows
`herdr machine reconnect <label>`; run it in a terminal, then let the hub retry.
A missing named Herdr session reports unavailable; the mirror never creates it
or falls back to default. Each retry checks the running-session list first.

Caches now use `~/.cache/hc-mirror/hosts-v1/<digest>` or the supplied cache root.
The first start recopies Sessions once. Old `~/.cache/hc-mirror/<host>` caches
remain intact. Delete old caches manually only when they are no longer useful.

Host sections replace cwd groups. Collapse a Host or hide it in the Hosts menu;
hide affects only presentation. `Leads + solo` hides ordinary Worker rows and
keeps Worker and status counts beside each lead. Needs you stays cross-host and
has its own collapse button with a retained count. Host headers retain counts.
These choices persist under `sessionMirror.*.v1`. Filter and Cmd-K search all
Hosts and hidden Workers. Results and the steering surface show the Host.

Keys: Cmd+F searches; Enter/Shift+Enter moves between hits; Cmd+K switches
Sessions; Esc closes search or interrupts a working agent. The composer forwards
prompts and slash commands to Herdr.

## Palette and type

Use the Palette select or press Alt+Shift+T to focus it. Dark and Light groups
contain fourteen palettes. Changes apply without a reload. The browser saves
the choice under `sessionMirror.theme.v1`; the default is Modus Vivendi Tinted.
Missing or invalid palette data uses the built-in dark default.

The IDE owns `themes.json` and its role bindings. Colorstack supplied reference
values; it is not an authority or dependency for this renderer. Duplication is
accepted. The recorded source commit is a courtesy note. No upstream checkout,
Python runtime, source verification or generation-equality gate is required.
Decision 0024 continues to exclude web palettes.

Paper Mono covers the whole UI. The local faces load at their declared weights;
the unmodified variable WOFF2 supplies a same-origin fallback with nonblocking
font swap. Body and metadata use 400, buttons use 500, headings and emphasis use
600, and strong text uses 700. Emphasis has no synthetic italic or link underline.
Without the font, the UI uses the system monospace stack. Font provenance and
the SIL OFL 1.1 licence live in `vendor/paper-mono/`.

Run `node --test tools/session-mirror/theme.test.mjs` for palette contrast,
pre-paint selection and malformed-data fallback checks. State edges supplement
tints; status shapes and labels supplement hue. Browser verification must also
check computed colours and fonts.

## Contracts and trust

- Native Pi JSONL owns Session evidence. The local copy and line indexes are
  rebuildable projections. A restart resumes transfer from cached byte offsets.
- Herdr owns runtime observations and command execution. Only prompt, interrupt
  and screen requests cross the write path. Interrupt requires a working agent.
- Session coordinates are `{host,path}`; pane coordinates are `{host,pane}`.
  `/agents` returns `{hosts,agents}` with Host IDs on agents. `/session` and
  `/search` require `host` and `path` query parameters. `/prompt`, `/interrupt`
  and `/screen` JSON bodies require `host` plus the existing `session` path.
  Slash commands use `/prompt`. Writes recheck the exact remote pane binding;
  ambiguity, stale bindings and wrong-Host paths fail without fallback or replay.
- `/events` sends an initial `hosts` snapshot, per-Host agents/link events and
  host-qualified append/reset/live events. `/watch` accepts arrays of
  `{host,pane}` and `{host,path}`. Initial watch/open query values use JSON arrays.
  Entry coordinates remain source line indexes. Slow SSE clients disconnect
  above 1 MiB of queued output and can reconnect.
- Exactly one configured Host retains legacy arrays, `/agents.link` and omitted
  Host references. Experimental TUI/native clients must start the hub with
  `--host local` when defaults would otherwise select several machines.
- Pi Team Bright is optional. Its public `pi-teams-observation/1` projection
  supplies labels only after an exact current pane-and-Session join. Labels do
  not confer Task or runtime authority. Unavailable reads keep the last view.
- The hub binds to loopback without authentication. It rejects non-loopback
  Host values, foreign POST Origins and POST bodies without JSON content type.
  These guards limit browser rebinding and cross-origin writes. Local processes
  can still read Sessions and issue commands. Session copies, browser content
  and screen output can contain secrets. Use only trusted hosts, Sessions and
  local clients. Do not expose the port to a network.

## Known gaps

In-flight assistant text appears through the remote screen until Pi persists
it. Interactive slash-command selectors are visible but cannot be operated.
Extension widgets and custom renderers are unavailable. Search uses substrings.
A forwarded port must keep the hub's port number because its Host guard checks
that number. Lag includes remote clock skew. The Herdr sidebar and this tool use separate
Team joins without a shared conformance fixture. Team reads have no error
backoff. Individual oversized JSONL lines can still consume a long event-loop
turn. Corpus scans and protocol frames yield between bounded batches. Escalate
to worker isolation if local last-page or search p50 exceeds 1.20 times B4 during
concurrent remote indexing.

## Verification

On 2026-10-16, a browser smoke with `--host local` listed 44 Session rows and
rendered a selected Session thread. The export dry-run, 27 release tests and
Structurizr DSL validation passed. Earlier local tests covered copy/resume,
large-Session paging/search, slash commands, interrupts, optional Team labels
and pinned prompts. Multi-host checks use explicit local plus the saved latency
machine. Registry/routing and fake-Herdr failure tests run with
`node --test scripts/test/session-mirror-hosts.test.mjs` in private HC.
