# Rarebit Status

`rarebit-status` is a ready-to-use local milestone for one exact Pi Session.
It projects producer-owned Rarebit artifact state into a two-tab popup: Summary
and Rarebit-message timeline. It is an external consumer, not a public release
gate or a Rarebit, Session, runtime, Task, or delivery authority.

## Behavior

The plugin binds only to Herdr's exact `agent_session { agent=pi, kind=path }`
path. It reads native Pi JSONL and the deterministic mirrored Rarebit sidecar
independently, then sends their availability and snapshots to
`projectRarebitArtifactState`. The producer owns receipt validity, recency,
selection lineage, request-generation applicability, and the five statuses:
`user_requested`, `finished`, `needs_attention`, `ineligible`, and `error`.

Source pending is a qualifier, not a sixth status. The popup exposes sync
state, applicability, artifact paths/availability, and lineage. It withholds
raw selected/native text when native JSONL is unavailable. The sidebar never
publishes operational `syncing`; it preserves existing metadata until a
truthful producer projection exists.

The deck imports marks, labels, tones, and attention gating from the package's
`rarebit-visual-language.mjs` contract. It owns only terminal-safe ANSI styling,
layout, and interaction, so producer provenance cannot create an extra visual
role and ordinary `finished` remains neutral. Sidebar projection uses mutually
exclusive neutral, attention, muted, and diagnostic state tokens because Herdr
styles token names, not values. Separate attention and error mark tokens keep
verified attention amber, ineligibility dim, and diagnostics red without
semantic inference in configuration.

The manifest exposes five real actions: `rarebit-status.open`, current/all
refresh, current clear, and current notification. It has three pane-agent
lifecycle events and one popup pane, `rarebit-deck`.

## Canonical local milestone

This is a local milestone procedure, not a public-release gate. It links only
the current canonical `main` checkout; source remains versioned in Git while
Herdr shortcuts/configuration remain machine-local.

```bash
main_root="$(git worktree list --porcelain | awk 'NR == 1 { sub(/^worktree /, ""); print; exit }')"
test "$(git -C "$main_root" branch --show-current)" = main
git -C "$main_root" rev-parse --verify HEAD
pi list | grep -F "$main_root/packages/hc-rarebit"
```

The listed package path must be exactly the canonical main path. Existing Pi
processes do **not** hot-reload extensions, so start a fresh Pi from that root,
run `/rarebit status`, make a persisted request/settlement, and prove the
actual v4 receipt from its exact Session path:

```bash
cd "$main_root" && pi
# In the fresh Pi: /rarebit status; record its exact Session JSONL path.
session_file='/absolute/path/reported/by/pi.jsonl'
sidecar="$(node --input-type=module - "$session_file" <<'NODE'
import { rarebitMaterializationPath } from '@hypercarrier/hc-rarebit';
console.log(rarebitMaterializationPath(process.argv[2]));
NODE
)"
node --input-type=module - "$session_file" <<'NODE'
import { readRarebitCurrent } from '@hypercarrier/hc-rarebit';
const current = await readRarebitCurrent({ sessionFile: process.argv[2] });
console.log(JSON.stringify({
  availability: current.availability,
  head: current.head,
  receipt: current.receipt && {
    schemaVersion: current.receipt.schemaVersion,
    promptVersion: current.receipt.promptVersion,
    lifecycleBoundary: current.receipt.lifecycleBoundary,
    sessionStatus: current.receipt.sessionStatus,
    statusReason: current.receipt.statusReason,
  },
}, null, 2));
NODE
```

Require a v4 compact receipt and a valid tail-readable `head`; do not inspect
physical last lines as current state. A successful receipt has only
`user_requested`, `finished`, or `needs_attention` as `sessionStatus`.

Relink the final plugin name and prove the machine-visible JSON record names
this exact root, plugin id, open action, and popup pane before reloading config:

```bash
plugin_id='rarebit-status'
plugin_root="$main_root/tools/rarebit-status"
herdr plugin disable "$plugin_id" || true
herdr plugin unlink "$plugin_id" || true
herdr plugin link "$plugin_root"
herdr plugin enable "$plugin_id"
herdr plugin list --plugin "$plugin_id" --json | jq -e --arg root "$plugin_root" '
  .result.plugins[0] as $plugin |
  ($plugin.plugin_id == "rarebit-status") and
  ($plugin.plugin_root == $root) and
  ([$plugin | .. | objects | .id?] | index("open") != null) and
  ([$plugin | .. | objects | .id?] | index("rarebit-deck") != null)'
# Change the machine-local shortcut command to rarebit-status.open before this check.
herdr config check
herdr server reload-config
```

On an exactly bound Pi pane, invoke the open action, verify the **Summary** and
**Rarebit-message timeline** tabs, and use `refresh-current`:

```bash
herdr plugin action invoke "${plugin_id}.open"
```

The deck must show the exact `session_file` and `sidecar`; a sidecar-only
request is `request recorded · source pending`, with no raw selected text or
attention sound.

Rollback is reversible and leaves versioned source/sidecars intact:

```bash
herdr plugin disable "$plugin_id"
herdr plugin unlink "$plugin_id"
herdr config check
herdr server reload-config
```

The XDG default state root is
`${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/rarebit-status`
(`HERDR_PLUGIN_STATE_DIR` may override it). Remove stale locks only after the
plugin is disabled **and** no entrypoint process remains:

```bash
state_dir="${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/rarebit-status}"
if pgrep -af '[s]cripts/(event|action|open|rarebit-dashboard|rarebit|startup)\.mjs'; then
  echo 'Plugin entrypoint still runs; do not remove locks.' >&2
  exit 1
fi
find "$state_dir" -type f -name '*.lock' -print
# Inspect the listed paths, then: find "$state_dir" -type f -name '*.lock' -delete
```

## Source bundle

- `herdr-plugin.toml` — plugin manifest.
- `scripts/rarebit.mjs` — artifact observation, producer projection adapter,
  reconciliation, presentation, and notifications.
- `scripts/rarebit-dashboard.mjs` — the two-tab Summary/timeline deck.
- `scripts/visual.mjs` — terminal rendering of the package-owned visual mapping.
- `scripts/open.mjs`, `scripts/action.mjs`, `scripts/event.mjs`,
  `scripts/startup.mjs` — Herdr entrypoints.
- `scripts/rarebit-status.test.mjs` — focused adapter tests.
