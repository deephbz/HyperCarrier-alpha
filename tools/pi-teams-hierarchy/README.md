# Pi Teams Hierarchy

`pi-teams-hierarchy` projects current Pi Team Bright Membership role names into
Herdr's expanded Agent sidebar. It is a presentation-only consumer.
It does not create Teams, infer identity from titles, mutate coordination state,
or own Herdr Agent lifecycle.

## Identity and composition

The plugin reads the public
`@hypercarrier/pi-team-bright/observation` projection and joins it to Herdr's
live Agent inventory by both exact pane ID and exact Pi Session JSONL path. It publishes only these source-owned metadata tokens:

- `pi_team_lead` for the leader Membership name;
- `pi_team_worker` for `↳ <stable Worker name>`;
- `pi_team_binding` as an internal pane-and-Session provenance hash. Sidebar
  configuration does not display this token.

The containing Herdr tab is the Team-level visual container. The sidebar does
not repeat the Team name on every Agent card. Reconciliation also clears the
retired `pi_team_name` token from earlier local prototypes.

An absent or stale Session match does not receive a label. An ambiguous match
is unchanged. Partial observation can publish an exact positive match, but it
cannot clear a label from absence alone. An exact ended Membership or a changed
provenance hash gives positive evidence to clear old presentation.

The plugin does not call `agent.view.set`, so Agent View Presets remains the
only optional filter owner. Its token names and metadata source differ from
Rarebit Status. Reconciliation clears only its three current tokens and the retired Team-name
token, so Rarebit metadata remains unchanged.

## Sidebar configuration

Herdr configuration owns layout and styling. Add one member row to the existing
`[ui.sidebar.agents]` `rows` array. Put it after the primary state/tab/workspace
row and before Rarebit rows:

```toml
  [{ token = "$pi_team_lead", fg = "#424140" }, { token = "$pi_team_worker", fg = "#75756f", dim = true }],
```

Missing custom tokens and their empty row disappear. Thus non-Team Agents keep
their current height. A Worker card renders `↳ worker-name` on one muted row. Herdr trims leading whitespace, so the
child glyph is the supported hierarchy cue. Custom rows apply only to the
expanded desktop sidebar.

Validate and reload the machine-local configuration after the edit:

```bash
herdr config check
herdr server reload-config
```

## Link and verify

The public Pi Team Bright observation build must be available from the same
HyperCarrier checkout. Run these commands from the checkout root:

```bash
plugin_root="$PWD/tools/pi-teams-hierarchy"
herdr plugin link "$plugin_root"
herdr plugin enable pi-teams-hierarchy
herdr plugin list --plugin pi-teams-hierarchy --json
herdr config check
herdr server reload-config
herdr plugin action invoke pi-teams-hierarchy.refresh-all
```

The JSON record must show plugin id `pi-teams-hierarchy`, the exact
`plugin_root`, enabled state, and both actions. The example role row is in
`config/herdr.example.toml` in a public Alpha checkout. Merge that row into the
live `[ui.sidebar.agents]` table before the check and reload steps.

The startup hook reconciles all live Agents. `pane.agent_detected` retries for
a bounded interval because Herdr can detect Pi before Pi Team Bright publishes
the new Membership. `pane.closed` reconciles remaining Agents so a Team leader
does not keep stale Team presentation after shutdown.

Receipts contain counts, pane IDs, and roles. They do not store Session paths or
Team/member names. The default state location is
`${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/pi-teams-hierarchy`.

Run the focused contract tests with:

```bash
node --test tools/pi-teams-hierarchy/scripts/pi-teams-hierarchy.test.mjs
```

## Rollback

Clear source-owned metadata before disabling or unlinking the plugin:

```bash
herdr plugin action invoke pi-teams-hierarchy.clear-all
herdr plugin disable pi-teams-hierarchy
herdr plugin unlink pi-teams-hierarchy
```

Remove the `$pi_team_*` member row from the machine-local Herdr configuration,
then run `herdr config check` and `herdr server reload-config` again.
