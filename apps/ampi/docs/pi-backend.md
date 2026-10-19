# Pi backend for AmPi

AmPi provides one GUI for Pi coding-agent Sessions running in Herdr panes on
local and remote Hosts. The pi-durable node backend remains deferred. This
file fixes the interfaces between the four parts so that each can be built and
tested alone.

```diagram
 Remote or local Host (SSH alias)                       Desktop (hub process)
┌──────────────────────────────────────────┐          ┌──────────────────────────────────────────────┐
│ Pi Session in a Herdr pane               │          │ PiHost (one per Host, src/pi/host.ts)         │
│   pi-hc-control extension                │          │   cache: append-only copy per Session file    │
│   └ unix socket per Session              │◄─────────┤   reader: trace-analytics bounded ranges     │
│ ~/.pi/agent/sessions/**.jsonl            │  actions │   topics: threads, thread, team               │
│ remote agent (src/pi/remote-agent.cjs),  ├─────────►│   ops: thread.submit, thread.abort            │
│   sent inline over `ssh <alias>`         │  bytes,  │ Hub ── WebSocket ── React GUI                 │
│   herdr CLI (layout, status, keys)       │  layout  └──────────────────────────────────────────────┘
└──────────────────────────────────────────┘
```

Rules that apply to every part:

- **Host identity.** A Host's ID is the owner's SSH config alias. The machine
  running the hub has an ID too: hub config `self`, which defaults to its
  `hostname`, never to a placeholder.
  Every Session reference is `<host>/pi:<sessionId>`; every entry citation is
  `<host>/pi:<sessionId>#<entryId>`. A local copy never changes them.
- **Reads** never cross SSH per request. The hub reads its local copies.
  Herdr data (workspaces, tabs, panes, labels, agent status) is auxiliary
  layout data; transcripts come only from the Session logs.
- **Writes** go to the named Host only, never to another.
- **Acknowledgements** say what they prove (`evidence` below). Nothing reports
  "admitted" unless Pi showed that it took the input.
- **Drafts.** Owner input from the GUI never loses a draft typed in the pane:
  the control path leaves the pane's editor untouched; the key path appends
  to the draft and submits both together.

## 1. Control extension (`packages/pi-hc-control`)

A Pi extension loaded in every Pi Session. On `session_start` it opens a unix
socket and writes a descriptor; on shutdown it removes both.

- Directory: `<PI_CODING_AGENT_DIR or ~/.pi/agent>/hc-control/`, mode 0700.
- Socket `<sessionId>.sock` (mode 0600) and descriptor `<sessionId>.json`:
  `{ schema: "hc-control/1", sessionId, sessionFile, socket, pid, nonce, startedAt, version }`.
  `socket` is the path to dial: a path too long for a unix socket falls back
  to a short one under the temporary directory.
  `nonce` is random per process start, so a stale descriptor cannot pass for a
  live Session.
- Frames: one JSON object per line.
  - `{ id, op: "status" }` →
    `{ id, ok: true, value: { sessionId, sessionFile, nonce, idle, compacting, pending: { steer, followUp }, submissions? } }`
  - `{ id, op: "submit", text, deliverAs: "steer" | "followUp" }` →
    `{ id, ok: true, evidence: "admitted" | "started", entryId?, submission? }` or
    `{ id, ok: false, error: { code, message } }`.
    When idle, `deliverAs` is ignored and a turn starts (`started`). When
    busy, it is queued as steer or follow-up (`admitted`). The reply is sent
    only after Pi shows the input: its `input` event for this text, then a
    pending queue or the saved user entry. `sendUserMessage` returning is
    never a receipt. Without that evidence within 30 s the answer is
    `ok: false, code: "not_admitted"`.
    While compaction runs, or while the C1 delivery hold is set, the
    extension waits (bounded, default 120 s) and then submits; on timeout it
    answers `ok: false, code: "busy_compacting"`.
  - `{ id, op: "abort" }` → `{ id, ok: true, evidence: "aborted" | "idle", submissions? }`.
- Queued submissions (admission is not delivery). An `admitted` reply
  names its `submission` ID. Status lists each queued submission and the last
  20 settled ones as
  `{ submission, deliverAs, state, at, entryId?, text, truncated? }`, text
  clipped to 16 KiB. `state` is `queued`, then `delivered` (Pi started the user
  message; `entryId` follows), `returned` (it left Pi's queue undelivered and
  Pi's editor draft holds it), or `dropped` (left undelivered, draft does not
  hold it). Pi's interactive abort and dequeue move queued input into the
  editor draft; Pi never sends it. An abort reply lists the submissions that
  were queued when it began, with their outcome. An older extension sends no
  `submissions`; absence proves nothing.
- Input from this path is the owner's input; Pi records it as a user message.

## 2. Remote agent v2 (`apps/ampi/src/pi/remote-agent.cjs`)

Evolved from Session Mirror's agent (which stays until Session Mirror
retires). Launched as `ssh -T <alias> node -e "<fixed bootstrap>"` (or run
locally). The first stdin line is `{ cfg, code }`: the base64 config (set as
`HCM_CFG`) and the base64 agent source. The rest of stdin carries commands.
The command line stays small and fixed, whatever the number of copied
Sessions. Stdout carries one JSON frame per line. Errors in
acks are `{ code, message }`.

Perf trace: when `AMPI_TRACE=<runDir>` is in the agent's environment (a local
Host inherits it from the hub; an SSH Host gets none), the agent records
Chrome Trace Event spans on the Unix-epoch µs clock: frames sent, Herdr
subcommands, control requests, Session reads, and discovery. It writes
`<runDir>/trace-<pid>-0.json` on exit, SIGTERM, or SIGINT. Args carry sizes
and outcomes only, never text or paths.

The pipe is a link with backpressure. The agent queues frames and keeps one
write in flight. It retries transient write errors (`EAGAIN`, `ENOBUFS`,
`ENOMEM`) and pauses Session copying above an 8 MB backlog. Acks have their
own queue. An ack goes out at the next frame boundary, ahead of queued
Session bytes, so an action's answer never waits for a copy backlog. Each
queue keeps its order. It exits only
when the hub is gone: stdin ends, a write fails with another error such as
`EPIPE`, the backlog passes 1 GB, or a signal arrives. Each exit writes
`remote-agent exit <code>: <reason>` to stderr. The hub puts that last line
in the Host status. When a command write to the agent fails, the hub ends
the link at once. Commands without an ack then fail with
`host_disconnected`, and the outcome is unknown. A control socket that
already read a submit still finishes it, and the Session file shows the
result.

Out (agent → hub):

- `hello { host, pid, herdr, herdrSession, control: boolean, at }`
- `reset { path, offset, truncatedHead }`, `chunk { path, offset, data }`: bytes
  of Session files, exactly as Session Mirror sends them.
  Copied: every Session file Herdr lists or a control descriptor names, and
  every file under `<agentDir>/sessions/` modified within `recentMs`
  (default four days), so Sessions run outside Herdr appear too.
- `agents { at, source, agents: [...], layout }`. Each agent:
  `{ session (file path), sessionId?, pane, workspace, tab, name, title, cwd,
  status, focused, control: { live, idle, compacting, pending, submissions? } | null }`.
  `submissions` passes the control's list through; a `delivered` one carries
  no text, because the Session file has it.
  An agent with a live control descriptor also carries `startedAt` (ms) from
  the descriptor. Its `session` file may not exist yet.
  `layout`: `{ workspaces: [{ id, label, tabs: [{ id, label, panes: [paneId…] }] }] }`
  in Herdr's order.
- `teams { status, codes, members: [{ pane, session, team, member, role }] }`
  (unchanged from Session Mirror).
- `limits { windows: { "provider/model": tokens }, budget: { tokens?, models?: { "provider/model": tokens } } | null, at }`:
  context windows layered as Pi's model registry layers them (`models-store.json`, then `models.json` `models`,
  then `modelOverrides`), and hc-auto-compact's global `auto_compact.budget_tokens` and per-model overrides from
  `settings.json`. Sent at start and when one of these files changes. The hub sets a Session summary's
  `contextWindow` and `workingBudget` (the budget clamped to the window) from it. Unseen: built-in catalogs never
  refreshed on the Host, extension providers, trusted project settings, and a Session's `/auto-compact budget`.
- `ack { id, ok, via: "control" | "keys", evidence: "admitted" | "started" | "aborted" | "idle" | "sent", entryId?, submission?, submissions?, error? }`
- `beat { at }`, `status { state }`.

In (hub → agent):

- `{ t: "submit", id, session, pane?, text, deliverAs: "steer" | "followUp" }`
- `{ t: "abort", id, session, pane? }`
- `{ t: "watch", ... }` as before.
- `{ t: "forget", id, path, bytes }`: stop copying an expired source only if it
  still exists, has the expected byte count, and has no known live agent.
  A successful ack returns `evidence: "untracked"` and a size/mtime watermark.
  Hub startup config returns saved `forgotten` watermarks. An unchanged old
  Team record cannot recopy it. Source changes or live evidence restore tracking.
  A missing original fails with `source_missing`; the hub retains its copy.

Routing: if a live control descriptor names `session` (matching file and a
socket that answers `status` with the same nonce), use the control socket.
Otherwise use Herdr keys after rechecking the exact pane↔Session binding:
steer = `herdr agent prompt <pane> <text>` while busy or idle; follow-up =
`herdr pane send-text <pane> <text>` (literal text; `agent send-keys` takes
key names only), then `herdr agent send-keys <pane> alt+enter`; interrupt =
`esc`. Key acks carry
`evidence: "sent"`.

## 3. Reader (`apps/trace-analytics`, owner of Pi parsing — )

The hub uses `openPiSessionRange(path, { host, indexPath })` and its streaming
`visit()` interface. The [range contract](../../trace-analytics/docs/transcript-range.md)
owns ancestry, content versions, byte pages and search-text extraction.
The full-reader API remains available to other consumers:

Library export `openPiSession(path, { host })` in
`src/sources/transcript.mjs` (package path `trace-analytics/transcript`):

- `refresh()` (async) reads bytes appended since the last call (byte
  offsets, like `scan.mjs`), and returns
  `{ reset: boolean, added: TranscriptEntry[] }`. `reset: true` means `added`
  holds the whole active branch and the consumer replaces its view: the
  first call, a shrunk or replaced file, or a new entry that does not extend
  the current tip (the branch moved).
  It never rereads the whole file after the first call unless the file shrank
  or was replaced.
- `session()` returns the SESSION record plus `host` and `ref`.
- `entries()` returns the active-branch entries in order.
- `TranscriptEntry`:
  `{ ref, id, parent, t, kind, name, role?, model?, provider?, usage?, blocks?, result?, customType?, summary?, text? }`
  with `blocks` of `{type:"text",text}`, `{type:"thinking",text}`,
  `{type:"toolCall",id,name,args}`, `{type:"image",mimeType}`, and `result`
  `{ callId, isError, text }` on tool results. `kind` keeps the record
  contract's values.

SESSION and ENTRY records gain `host` (the hub always passes the Host ID)
and `ref`. Existing ids stay as they are.

## 4. PiHost (`apps/ampi/src/pi/host.ts`)

A hub-side link that speaks the same frames as a node link, so the hub and the
GUI keep one protocol. It spawns the remote agent, keeps the local cache,
reads Sessions through the reader, and serves:

- topic `threads`: `ThreadSummary` per Session, plus `host`, `location`
  `{ workspace, tab, pane }` and Herdr labels, `team`, `control`;
- topic `thread`: a bounded transcript window with `sourceVersion` and
  `hiddenBefore`. Entries disclose `bodyAvailable` when source bytes are omitted;
- `thread.history { threadId, before?, around?, limit?, version? }`: a bounded
  indexed page. `around` jumps directly to an old entry; stale versions fail;
- `thread.entry { threadId, entry, offset?, version? }`: up to 64 KiB of exact
  native JSON plus `next`, `more`, `format`, and `version`;
- `sessions.search { query }`: at most 100 FTS prose hits per Host;
- `thread.find { threadId, query }`: streamed case-insensitive substring search
  over the complete copied active branch, with at most 200 entry hits.
  Both search operations return scope, exclusions and coverage;
- `view.cos.timeline.locate { threadId, at }`: exact nearest visible entry;
- op `thread.submit { text, whenBusy: "steer" | "followUp" }` and
  `thread.abort`, forwarded to the remote agent; the reply carries `via`,
  `evidence`, and `entryId` when the control socket names the entry. A queued
  submit names its `submission`; an abort lists `submissions` with outcomes.
- the thread view's `inbox.items`: each undelivered queued submission
  `{ id, mode, content, state, truncated? }`. The hub keeps the full text it
  sent. `state` adds `unknown` when the live control stops listing a queued
  one (Pi restarted or switched Session). The composer shows `returned` as
  "not sent · returned to Pi's input box" with **Edit here**, which copies the
  text into the AmPi composer. Nothing is re-sent automatically.
- op `thread.withdraw { submissionId }` dismisses a settled item. Pi cannot
  take back one queued message, so a `queued` item answers `unsupported`.

Presence: a Session exists on the Host when a copy has its header, this
hub's spawn ledger names it, or a live control descriptor names it. Pi writes
the Session file only with the first message. Until then a live descriptor
lists the Session as `live` with an empty transcript, and `thread.submit`
and `thread.abort` go to its socket. The thread id is `pi:<descriptor
sessionId>`, so the copy replaces the entry under the same id once the
file arrives. A descriptor whose pid is dead, or whose socket does not answer
with its nonce and file, is not presence.

## 5. Herdr control (stage 2)

The GUI creates and closes Pi agents in Herdr. Herdr stays the owner of panes,
tabs, and workspaces; the GUI only asks. Every verb below is one PTB already
uses against a real Herdr; no other Herdr verb is used. Creating a tab is out
of scope until its verb is verified.

The new Session is named before anything runs: its ID is the request's
`requestId` (a UUID), passed to Pi as `--session-id`, which Pi 1.1 creates
if missing. The thread is therefore `pi:<requestId>` before Herdr acts, and
a retried request finds the same Session instead of starting another.

Ops (GUI → PiHost):

- `thread.create { cwd, place, name?, prompt?, requestId }` with `place`
  either `{ beside: threadId, direction: "right" | "down" }` or
  `{ workspace: "new", label? }`. Answers `{ threadId, pane, evidence,
  submitted?, pending? }` once Herdr acknowledges the start. Pi writes a
  Session file only after its first message, so until a copy binds, the
  hub lists a placeholder for the new thread (its name, place, and "waiting
  for its first message"); the thread opens at once with an empty
  transcript, and a message to it is typed into its pane. `pending: true`
  says no copy is bound yet. The placeholder survives a hub restart and
  leaves when the copy binds or Herdr stops listing the pane.
- `thread.resume { threadId, place, requestId }`: starts Pi again on a
  Session that runs in no pane (`already_running` otherwise), with `place`
  as for `thread.create` and the Session's cwd. Pi gets `--session <file>`,
  as in Pi Team Bright's exact resume. Answers `{ threadId, pane, evidence }`;
  the copy binds to the new pane once Herdr lists it.
- `thread.close { threadId, lastPane? }`: closes the Session's pane. Close is
  a suspend: it frees the pane and the Pi process and says nothing about
  whether the work is done; the Session stays on its Host and resumes any
  time.
  Refusals: `team_worker` (Pi Team Bright owns a worker's pane; its lead
  stops it), `team_unknown` (Pi Team Bright is installed but its state has
  not been read in 30 s, so the pane may be a worker's), `final_pane` (the last pane in its workspace, unless the owner
  confirmed with `lastPane: true`), `pane_moved` (the pane no longer shows
  that Session). The transcript stays readable from its copy, under
  "Not in a pane", and stays listed however old it is.
- A `prompt` travels with the spawn and is typed into the new pane right
  after Pi starts (`submitted: { via: "keys", evidence: "sent" }`). A prompt
  that cannot be sent does not fail the create: `submitted` then holds
  `{ error: { code, message } }`.
- A start Herdr refuses after the pane exists fails the create with
  Herdr's code and names the pane left open.

Remote agent commands:

- `{ t: "spawn", id, requestId, sessionId | resume, cwd, beside?: pane, direction?, label?, name?, prompt? }`.
  A ledger `<agentDir>/hc-control/spawns/<requestId>.json` (0600), claimed
  atomically (create-exclusive) before any Herdr call, makes it idempotent: a recorded pane is answered from the ledger and never split
  again; a ledger stuck at "splitting" answers `outcome_unknown`. Steps:
  - beside a pane: `herdr pane split --pane <pane> --direction <d> --cwd <cwd> --no-focus`
    → `{ pane: { pane_id } }`;
  - new workspace: `herdr workspace create --no-focus --cwd <cwd> --label <label>`
    → `{ workspace: { workspace_id }, tab: { tab_id }, root_pane: { pane_id } }`;
  - record the pane in the ledger;
  - `herdr pane rename <pane> <name>` (failure is only a warning);
  - `herdr agent start <name> --kind pi --pane <pane> --timeout <ms> -- --session-id <sessionId>`,
    or `-- --session <file>` when resuming.
  - Ack `{ id, ok, via: "herdr", evidence: "started" | "unknown", pane, name, repeat?, warning?, fact? }`;
    `repeat` marks an answer from the ledger, `warning` a failed rename.
    `unknown` means Herdr did not confirm the start after the pane existed.
    A split that times out answers `ok: false, code: "outcome_unknown"`:
    a pane may exist, so the owner checks Herdr. Nothing is retried.
- `{ t: "close", id, session, pane, lastPane? }`: `herdr pane get <pane>`,
  `herdr pane list --workspace <ws>`, recheck the pane↔Session binding and
  Team membership, then `herdr pane close <pane>`. Ack
  `{ id, ok, via: "herdr", evidence: "closed" }`. Herdr has no conditional
  close, so a pane that changes between the recheck and the close is a
  known, narrow race.

Herdr replies are JSON envelopes; `result` holds the value and `error`
`{ code, message }` a refusal.

## Latency budget

Moving between Sessions and views: 50 ms at p95 from click to first paint,
from local copies. Indexes are built when bytes arrive, never when a view
opens. The GUI renders the newest entries first and keeps recent views warm.
