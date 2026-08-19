# Herdr Pi Recovery

`herdr-pi-recovery` preserves the correspondence between stable Herdr pane IDs and Pi conversation sessions. Its canonical artifact is JSON: the raw Herdr API snapshot plus process and Pi lifecycle evidence, resolved session references, and exact resume commands.

The pure transformations live in `herdr_recovery.core`; `herdr_recovery.cli` is the subprocess/filesystem shell. It requires Herdr 0.7.5 or newer, Python 3.12 or newer, and [uv](https://docs.astral.sh/uv/).

This tool is a checkout-local CLI, not a Herdr plugin. Do not use
`herdr plugin link` for it. It reads Herdr through the official CLI and changes
live panes only when you explicitly run `restore --execute`.

## Check and run from a checkout

From this checkout:

```sh
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery doctor
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery dump
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery query
```

`doctor` must pass before you rely on a dump or restore plan. Dumps are written
atomically under `~/.local/state/herdr-pi-recovery/snapshots/`; `latest.json`
points to the newest successful dump.

## Restore after reboot

Start or attach to Herdr so it reloads its persisted workspace, tab, and pane topology, then inspect the plan:

```sh
herdr
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery plan
uv run --locked --project tools/herdr-pi-recovery herdr-pi-recovery restore --execute
```

Restore is dry-run by default. It blocks missing panes and skips panes already containing a detected agent. `--force` overrides the latter guard and should only be used after inspecting the target pane.

Install Herdr's official Pi integration once:

```sh
herdr integration install pi
```

New Pi processes then report their session references directly to Herdr, which also enables Herdr's native `session.resume_agents_on_restore` behavior. Processes without a native Herdr session reference remain unresolved rather than being joined through Timeline state.

## Query one pane or raw JSON

```sh
herdr-pi-recovery query --pane w4:p3
herdr-pi-recovery query --json
herdr-pi-recovery plan --json
```

Run tests with:

```sh
uv run --locked --project tools/herdr-pi-recovery \
  python -m unittest discover -s tools/herdr-pi-recovery/tests
```
