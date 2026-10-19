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
clients and pipelined requests are allowed. Ops: `status`, `submit`, `abort`.

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
