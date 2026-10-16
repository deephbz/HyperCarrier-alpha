# Session mirror web IDE

Read, search and steer remote Pi Sessions from a local browser. The hub keeps a
rebuildable disk copy and indexes each Session. Reading and search need no remote
round trip. This HC tool is in consolidation. Its HTTP API remains unstable.

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
node tools/session-mirror/mirror.mjs --host my-server
# Local test with simulated one-way delay:
node tools/session-mirror/mirror.mjs --host local --delay-ms 150
# Open http://127.0.0.1:7777/
```

Options: see the `mirror.mjs` header. `--port` and `--cache-dir` isolate a test
hub. `--teams off` disables optional Pi Team Bright labels. The target needs no
mirror installation. The hub sends the remote agent inline over one SSH channel.

Verified only with `--host local`; remote SSH is unverified.

Keys: Cmd+F searches; Enter/Shift+Enter moves between hits; Cmd+K switches
Sessions; Esc closes search or interrupts a working agent. The composer forwards
prompts and slash commands to Herdr.

## Contracts and trust

- Native Pi JSONL owns Session evidence. The local copy and line indexes are
  rebuildable projections. A restart resumes transfer from cached byte offsets.
- Herdr owns runtime observations and command execution. Only prompt, interrupt
  and screen requests cross the write path. Interrupt requires a working agent.
- The HTTP API lives in the hub header. SSE carries appends, resets, agent lists
  and watched screens. Entry coordinates use source line indexes.
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
backoff. Real remote SSH operation remains unverified.

## Verification

On 2026-10-16, a browser smoke with `--host local` listed 44 Session rows and
rendered a selected Session thread. The export dry-run, 27 release tests and
Structurizr DSL validation passed. Earlier local tests covered copy/resume,
large-Session paging/search, slash commands, interrupts, optional Team labels
and pinned prompts. These checks do not verify real remote SSH operation.
