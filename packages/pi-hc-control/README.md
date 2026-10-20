# HC Control

HC Control gives each live Pi Session a local control socket so the one GUI can
submit owner input, abort, and read status without typing into the pane. It
owns the socket, its descriptor, and evidence-backed acknowledgements. It does
not own routing, Herdr key fallback, transcripts, or compaction policy.
Status: stage 1 of D15. Contract:
[Pi backend §1](../../apps/ampi/docs/pi-backend.md#1-control-extension-packagespi-hc-control).

## Load

Requires Pi 1.1.0 or newer in the 1.x line. Add the package to Pi's settings
(`~/.pi/agent/settings.json`):

```json
{ "packages": ["/path/to/hypercarrier/packages/pi-hc-control"] }
```

or try it for one run with `pi -e ./packages/pi-hc-control`.

## Endpoint

On `session_start` the extension writes, under
`<PI_CODING_AGENT_DIR or ~/.pi/agent>/hc-control/` (mode 0700):

- `<sessionId>.sock`, mode 0600;
- `<sessionId>.json`: `{ schema: "hc-control/1", sessionId, sessionFile, pid,
  nonce, startedAt, version, socket }`.

`socket` is the actual socket path. When the preferred path exceeds the unix
socket limit (103 bytes), the socket lives in a private `hc-ctl-<uid>/`
directory under the OS temp directory (or `/tmp`). Session shutdown, a switch
to another Session, and process exit remove both files. A new endpoint sweeps
descriptors whose pid is dead.

Frames are one JSON object per line; replies carry the request `id`. Multiple
clients and pipelined requests are allowed. Ops: `status`, `submit`, `abort`,
`commands`, `command`. `status.commands = 1` announces the last two; an older
control answers them `unknown_op`.

## Acknowledgements

`pi.sendUserMessage()` returns nothing and reports failures only to Pi's error
notice, so a call is never an acknowledgement. Submissions run one at a time
in arrival order:

1. Wait while Pi compacts or any C1 `hc.delivery-hold` lease is active
   (default up to 120 s, else `busy_compacting`).
2. Call `sendUserMessage(text, { deliverAs })`.
3. Watch Pi's `input` event for this exact text with `source: "extension"`.
   - Idle (`streamingBehavior` absent): reply `started` with `entryId` once
     the user `message_start`/`message_end` pair appears and Pi persists the
     entry.
   - Busy: reply `admitted` once `ctx.hasPendingMessages()` is true after the
     input handlers return, or the user message is already delivered.
4. Otherwise reply `not_admitted` after 30 s (paused while compacting).

An `admitted` reply names a `submission` ID. Pi takes queued input back only
all at once: its interactive abort and dequeue move the queue into the editor
draft, and Pi never sends it. So the extension tracks each admitted submission
until Pi is idle with nothing pending. Then it is `delivered` (with `entryId`),
`returned` (the editor draft holds its text), or `dropped`. `status.submissions`
lists queued submissions and the last 20 settled ones, text clipped to 16 KiB
(`truncated`). An `abort` reply lists `submissions` that were queued when it
began, with their outcome.

`status.pending` mirrors Pi's queue from observed `input` and user
`message_start` events and resets whenever Pi reports nothing pending. `held`
reports an active C1 lease. Error codes: `bad_request`, `too_large` (text over
1 MiB), `unknown_op`, `busy_compacting`, `not_admitted`, `abort_timeout`,
`closed`, `internal`.

## Slash commands

Invariant: a slash command reaches Pi as a typed call or not at all. `submit`
never expands commands, so `/model x` sent through `submit` becomes a user
message. A client sends a command through `command` instead.

`{ op: "commands" }` returns
`{ commands: [{ name, description?, argsHint?, source, supported }], models: [{ ref, name? }], model, thinkingLevels, thinking }`.
`commands` holds the supported built-ins, the TUI-only built-ins with
`supported: false`, and `pi.getCommands()` (`source` `extension`, `prompt`,
or `skill`). `models` lists the available `provider/id` refs for `/model`
completion; `model` is the current one.

`{ op: "command", name, args?, key?, abort?, deliverAs? }` checks `name` again
just before dispatch, in the same chain as `submit`. A successful reply
carries a `disposition`:

| Command | Pi call | Reply |
| --- | --- | --- |
| `/model <ref>` | exact `provider/id` or bare-id match over available models, then `pi.setModel` | `handled`, notice `Model: <ref>`, `effect.model` |
| `/thinking <level>` | `pi.setThinkingLevel` (Pi clamps it) | `handled`, notice names the effective level |
| `/name <text>` | `pi.setSessionName` | `handled` |
| `/compact [instructions]` | `ctx.compact` | idle: `handled`, `evidence: "compaction_started"`; busy: `busy` error unless `abort: true` |
| extension command | `sendUserMessage(text, { expandPromptTemplates: true })` | `dispatched`: Pi reports no result; errors show only in the Pi pane |
| skill or prompt template | the same call | `started` with `entryId`, or `queued` with `submission`, as for `submit` |

Pi 1.3.0 documents `setModel` as "Set the model for the current session
without changing the configured default for new sessions" (`types.d.ts`,
`ExtensionAPI.setModel`). It appends a `model_change` entry and no user
entry, so a reader sees the new model before the next turn.

- `effect` is for the notice only. The Session file stays the authority.
- Order: the control checks commands in the same chain as `submit`. A
  `handled` or extension command then takes effect at once, ahead of queued
  messages; `deliverAs` applies only to a skill or template. `/model` while a
  turn runs applies from Pi's next model call.
- `busy_compacting` is checked before dispatch, as a precondition.
- A started skill or template names the first user entry after its `input`
  event. That `entryId` is best-effort when the owner types in the Pi pane at
  the same moment.
- A queued expansion reaches Pi as different text. Its submission settles as
  `returned` when the editor draft holds the raw text, else `unknown`, never
  `dropped`.
- `key` makes a retry return the first reply without running the command
  again. The runtime keeps the last 100 keys; a Pi restart or `/reload` loses
  them.
- Errors: `unknown_command` and `unsupported_command` (a TUI-only built-in
  such as `/reload`, `/new`, `/fork`, `/settings`) send nothing. `bad_args`
  (no match, or an ambiguous bare id with `matches`), `auth_missing`
  (`setModel` returned false), `busy`, plus the `submit` errors.

`@hypercarrier/pi-hc-control/client` provides `connect`, `request`, `probe`,
and `findSession`. A descriptor is live only when its pid is alive and its
socket answers `status` with the same `sessionId` and `nonce`.

## Security

- Local only: a unix socket in a 0700 directory, socket and descriptor 0600.
  The fallback directory must be a real directory owned by the current user.
- Anyone who can open the socket can type into the Session as the owner.
  The trust boundary is the user account; there is no extra authentication.
- The nonce identifies one endpoint start. It is not a secret credential.
- Input lands in Pi's queue only; the pane's editor draft is never touched.

## Test

```sh
npm --prefix packages/pi-hc-control test
```

`test/control.sim.test.mjs` runs the real Pi SDK through `@hypercarrier/pi-sim`
(sockets are disallowed there, so the transport is a recorder).
`test/endpoint.test.mjs` uses real sockets. If the installed Pi fails to
import, point `HC_PI_SIM_PI_ROOT` at a pinned install (see the pi-sim README).
