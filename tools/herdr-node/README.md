# Herdr plugin Node launcher

`launch.sh` starts the three HC Herdr plugins when the server PATH lacks Node.
It owns runtime discovery only. It does not install Node or change the server
environment. Keep `tools/herdr-node` beside the plugin directories.

## Configure

Write one absolute executable path on the first line of
`$(herdr plugin config-dir <plugin-id>)/node-path`. The launcher reads this file
on every invocation, so a change needs no server restart. Do not add shell
quotes. Paths with spaces work.

Resolution order:

1. `$HERDR_PLUGIN_CONFIG_DIR/node-path`.
2. `$HERDR_NODE`, as an absolute executable path in the server environment.
3. `node` on the inherited PATH.
4. Homebrew arm64/Intel paths, fnm default aliases (XDG and macOS), nvm default
   alias, Volta, mise and asdf shims. `FNM_DIR` and `NVM_DIR` can override their
   default roots. nvm version aliases and bounded alias chains are supported.
5. `$SHELL -lc 'command -v node'`, with `/bin/sh` as the default shell.

The first executable candidate that reports a Node version wins, including a
too-old Node. A Node major below 22 stops resolution with an error; the launcher
does not search later locations for a newer Node. Select a supported Node through
the config file or `HERDR_NODE` to override an older PATH or fixed candidate.
An invalid explicit file or `HERDR_NODE` fails closed. It does not silently
select a different runtime. A missing runtime exits 127 with the plugin name
and the expanded per-plugin node-path file path when Herdr provides its config
directory. Each successful discovery prints the path and version to stderr.
The major floor comes from the checkout's `package.json` engines requirement (`>=22.19`) and
the existing plugin requirements. Keep Node 22.19 or newer for full dependency
compatibility; this bootstrap checks only the major.

Herdr captures hook/action stderr in plugin command logs. Pane stderr appears
in the pane. Login lookup runs profile code only after cheaper checks fail.
The launcher never evaluates the node-path file as shell code.

## Shared location evidence

[Herdr plugin docs](https://herdr.dev/docs/plugins/), “Commands and environment”,
specifies argv execution with the plugin root as cwd. `herdr plugin --help`
and `herdr plugin link --help` expose local directory linking without a copy
or build step. Herdr's source confirms the mechanics:

- `src/app/api/plugins/manifest.rs`, `load_plugin_manifest`, canonicalizes the
  manifest and stores its parent as `plugin_root`.
- `src/app/api/plugins/runtime.rs`, `start_plugin_command`, sets
  `.current_dir(plugin_root)` before spawning the argv command.
- `src/cli/plugin.rs`, `GithubPluginSource::manifest_root`, retains a selected
  subdirectory inside the full managed checkout.

These source paths belong to [Herdr](https://github.com/ogulcancelik/herdr).
There is no plugin-directory sandbox. Thus `/bin/sh ../herdr-node/launch.sh`
works from a linked plugin root. HC's `release/public/export-manifest.json`
preserves the same sibling layout in Alpha and selects this launcher's source,
tests and README. No per-plugin copies or generated launchers are needed.
Link the plugin from a full HC or Alpha checkout; copying only a plugin
subdirectory omits its shared dependency.

Run the bootstrap tests and the three existing plugin suites:

```sh
node --test tools/herdr-node/launch.test.mjs tools/*/scripts/*.test.mjs
```

Tests launch `/usr/bin/env -i HOME=... PATH=/usr/bin:/bin` with temporary config
and runtime fixtures. They check both linked and projected Alpha paths without
changing Herdr's global plugin registry. Fixed-location and missing-fallback
checks skip when the host already has an earlier system Node candidate.
Explicit configuration, failure and argument-preservation checks always run.
The export-selection check reads the source-only export manifest. It skips with
an explicit reason when that manifest is absent in Alpha. All other launcher
checks run in both layouts.
