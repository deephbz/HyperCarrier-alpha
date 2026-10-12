# whereami

`whereami` reports how an agent process relates to its human. It reads local process, terminal, display, browser, network, storage, and harness state. It runs diagnostic probes and does not control panes or applications. Browser checks start at loopback URLs; the current HTTP client can follow redirects and use environment proxy settings.

## Requirements

- Python 3.10 or newer
- macOS or Linux
- Python standard library only

## Install and use

Make the script executable and place it on your `PATH`, or run it directly:

```sh
chmod +x whereami
./whereami
./whereami chain terminal --json
./whereami all
```

The default command prints a short summary. A section name prints its details. Use `all` for every section and `--json` for structured output. Optional probes use local tools such as `tmux`, `tailscale`, `loginctl`, and `lsof`; missing tools produce incomplete results.

## Privacy

Output can contain usernames, hostnames, working and home paths, process arguments, IP addresses, Wi-Fi names, browser profile paths, and network details. Review output before sharing it. Avoid posting full output in public issues or logs. The output is not anonymized.

Attachment and visibility results use heuristics. They do not prove that a human
is watching, that a pane has focus, or that a discovered client belongs to the
same server. Use the terminal's own CLI to verify the exact pane before control.
Prefer loopback serving with an explicit SSH tunnel over binding a web UI to a
network interface.
