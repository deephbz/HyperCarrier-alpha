# Rarebit runbook

Set `rarebit.model` in global Pi settings, or in a trusted Project's
`.pi/settings.json`. It must be `provider/model` (or `{ "provider", "id" }`);
Rarebit fails closed when it is missing or invalid. It deliberately does not
inherit Pi's interactive `defaultModel`.

After an extension change, run `/reload` in an existing Pi Session. The
extension works from the persisted active branch and runs detached: a reload,
a persisted direct owner input, and a normal `agent_settled` checkpoint may
enqueue materialization without blocking the TUI. ESC/aborted work and
extension-origin input do not produce an automatic checkpoint.

Inspect derived records without treating them as a transcript:

```sh
tail -n 1 ~/.pi/agent/rarebit/materializations/<cwd-key>/<session>.jsonl | jq .
hc-rarebit query --session <session-id> --json
hc-rarebit extract --session <session-id> --json
```

An automatic summary is eligible only when the active branch is at least
`min_total_length` estimated tokens (`ceil(all-readable-message-chars / 4)`) and
selected Rarebit prose is at most `max_rarebit_ratio` of those same raw chars.
`/rarebit summarize` and `hc-rarebit summarize` are explicit owner requests and
can force a summary; the derived receipt records the policy and force status.

`/rarebit title` is an explicit generated retitle. Automatic title generation
is conservative: it relies on exact persisted first-owner evidence and never
overwrites a pre-existing human title. The standalone CLI only proposes a title.
