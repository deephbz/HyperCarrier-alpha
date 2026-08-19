# Agent View Presets

`agent-view-presets` is a local Herdr plugin for operator-selected projections
of the built-in Agent list. It does not create Agents or change detection,
notifications, attention counts, pane layout, or Agent metadata.

It requires Herdr 0.7.5 or newer and Node.js 22.19 or newer.

## Install and verify

Run these commands from the HyperCarrier checkout root:

```bash
plugin_root="$PWD/tools/agent-view-presets"
herdr plugin link "$plugin_root"
herdr plugin enable agent-view-presets
herdr plugin list --plugin agent-view-presets --json
herdr config check
herdr server reload-config
```

The JSON record must show plugin id `agent-view-presets`, the exact
`plugin_root`, and enabled state. A plugin update needs no new link. Reload the
Herdr server after you change the live configuration.

Use one of the three actions:

```bash
herdr plugin action invoke agent-view-presets.toggle-teammates
herdr plugin action invoke agent-view-presets.no-teammates
herdr plugin action invoke agent-view-presets.all-agents
```

`no-teammates` hides exact active Pi Team Bright Worker panes. `all-agents`
clears this plugin's filter. The toggle switches between these two states.

Optional keybinding:

```toml
[[keys.command]]
key = "prefix+shift+v"
type = "plugin_action"
command = "agent-view-presets.toggle-teammates"
description = "toggle active PiTeams teammates"
```

After you add the keybinding, run `herdr config check` and
`herdr server reload-config` again.

## Identity and composition

Teammate identity comes from current Pi Team Bright Membership records under
`~/.pi/teams/*/config.json`. Only active records with
`agentType = "teammate"` and an exact Herdr pane `terminalTarget` are hidden.
Leaders, inactive members, non-Herdr targets, and inferred name or title
patterns stay visible. If one Team config is unreadable or malformed, the
action fails without changing the active Agent view.

Grouped and priority remain Herdr sort policies. The no-teammates filter omits
a custom sort, so either policy continues to apply. This plugin is the only
HyperCarrier plugin that calls `agent.view.set`. Pi Teams Hierarchy reports
metadata only, and Rarebit Status owns separate metadata tokens. Thus all three
plugins can run together.

The selected preset is saved under `HERDR_PLUGIN_STATE_DIR`. Startup and pane
lifecycle hooks reapply `no-teammates` after a server restart or Team pane
change. Receipts are appended to `receipts.jsonl` in the same directory.

## Test and remove

Run the focused tests from the checkout root:

```bash
node --test tools/agent-view-presets/scripts/agent-view-presets.test.mjs
```

Clear the filter before you disable or unlink the plugin:

```bash
herdr plugin action invoke agent-view-presets.all-agents
herdr plugin disable agent-view-presets
herdr plugin unlink agent-view-presets
herdr config check
herdr server reload-config
```
