# Terminal configuration examples

These files are optional examples. Merge only the settings you need into your own configuration. They do not install applications, plugins, services, or fonts.

- `herdr.example.toml` contains Herdr server keybindings and optional UI/plugin controls. Pane and tab shortcuts use the Ctrl+b prefix and Ghostty Cmd-key bindings. Rarebit Status, Agent View Presets, and file-viewer commands need their matching plugins. `herdr.plugins.lock.toml` records checkout-local plugin paths and the external viewer pin; plugin installation is optional. Checkout-local plugins need their package dependencies and submodules.
- `herdr-pane-defaults.toml` is the canonical color-free pane fragment. Insert its bytes inside the server `[ui]` table. It has no table header and cannot serve as a complete server configuration. Private deployment consumes an exact-byte vendor copy with a committed source pin; it does not read an adjacent checkout. Scoped receipt-backed adoption of these three pane defaults is verified with unchanged parsed configuration. This does not establish visual acceptance. Other terminal-template consumers remain incomplete; their existing deployments stay in place.
- `herdr-gpui.example.toml` selects the minimal GPUI layout. It inherits theme and terminal font choices. Merge it into `config-gpui.local.toml` under your Herdr configuration directory (normally `~/.config/herdr`). Server settings belong in `config.toml` in that directory.
- `ghostty.example.config` passes macOS keyboard shortcuts to Herdr. Ghostty uses its default font unless you set an optional font in your own configuration.

Herdr server and GPUI configuration have separate settings. Runtime plugin state, installed checkouts, sessions, sockets, logs, and live configuration remain outside these examples. No daemon or service setup is provided.
