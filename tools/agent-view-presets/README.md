# Agent View Presets

Local Herdr plugin for operator-selected projections of the built-in Agent list.
It does not create Agents or change detection, notifications, attention counts,
or the underlying pane layout.

## Presets

- **No teammates** hides exact active PiTeams teammate panes.
- **All agents** clears this plugin's projection.

Grouped and priority remain Herdr sort policies. The no-teammates filter omits a
custom sort, so either policy continues to apply.

Teammate identity comes from current PiTeams Membership records under
`~/.pi/teams/*/config.json`. Only active records with `agentType = "teammate"`
and an exact Herdr pane `terminalTarget` are excluded. Leaders, inactive
members, non-Herdr targets, and inferred name/title patterns are not excluded.
If any Team config is unreadable or malformed, the action fails without changing
the active Agent view.

## Link and use

```bash
herdr plugin link /absolute/path/to/tools/agent-view-presets
herdr plugin enable agent-view-presets
herdr plugin action invoke agent-view-presets.toggle-teammates
herdr plugin action invoke agent-view-presets.no-teammates
herdr plugin action invoke agent-view-presets.all-agents
```

Optional keybindings:

```toml
[[keys.command]]
key = "prefix+shift+v"
type = "plugin_action"
command = "agent-view-presets.toggle-teammates"
description = "toggle active PiTeams teammates"
```

The selected preset is saved under `HERDR_PLUGIN_STATE_DIR`. Startup and relevant
pane lifecycle hooks reapply no-teammates after a server restart or Team pane
change. Receipts are appended to `receipts.jsonl` in the same directory.
