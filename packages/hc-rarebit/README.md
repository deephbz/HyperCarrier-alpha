# `@hypercarrier/hc-rarebit`

Rarebit is a sparse, deterministic evidence projection over the active branch
of a persisted Pi Session. It selects every textual user message and textual
assistant `toolUse`/`stop` prose; it excludes tool payloads/results and hidden
reasoning. Native Pi Session JSONL remains the raw evidence authority.

Rarebit keeps three different things separate:

- **Rarebit evidence** is the ordered selected raw prose and provenance.
- **Rarebit Summary** is an optional lossy model derivation over that complete
  evidence.
- **Rarebit Title** is a mutable human-facing Session-label proposal, not
  Session identity or evidence.

The package has one backend with two shells. The functional core owns the
Rarebit predicate, branch measurement and eligibility policy, prompt
composition, output normalization, and deterministic job identity. The shared
imperative services own model invocation, private append-only receipts, and
cross-process dedupe for both Summary and Title. The Pi extension contributes
lifecycle triggers, TUI notifications, and an explicit Session-label apply
adapter; `hc-rarebit` contributes argument parsing, native-Session lookup, JSON
output, and proposal-only Title behavior. Neither shell redefines selection,
policy, prompts, model receipts, or persistence.

## Pi extension

Configure a dedicated model rather than inheriting the interactive model:

```json
{
  "rarebit": {
    "model": "openai-codex/gpt-5.6-luna",
    "min_total_length": 80000,
    "max_rarebit_ratio": 0.4,
    "auto_title": true
  }
}
```

`min_total_length` is an explicitly labelled model-independent estimate:
`ceil(all readable active-branch message characters / 4)`. `max_rarebit_ratio`
is selected Rarebit characters divided by that same raw character denominator.
Automatic synthesis requires both thresholds; it never silently falls back to
the interactive `defaultModel`. The extension materializes in detached work at
session start, after persisted direct owner input, and after normal settlement.
It does not block prompt entry or add model-visible messages.

`/rarebit summarize` requests a deliberate forced summary. `/rarebit title`
is a deliberate generated retitle. Automatic title generation uses the exact
first persisted direct interactive/RPC owner message and never overwrites an
existing title. After resume, an explicit generated retitle may use the
earliest persisted user Rarebit when runtime origin provenance is unavailable;
the receipt labels that weaker evidence `branch_user_fallback`. Both paths
revalidate the exact active Session and unchanged prior title immediately
before applying the local `YYYYMMDD-` label. Use Pi's native `/name` command
for a literal title.

The extension exposes only `/rarebit`, with `status`, `config`, `auto-title`,
`title`, and `summarize` subcommands. `config max_rarebit_ratio <0..1>` and
`config min_total_length <nonnegative estimated tokens>` are validated
process-local overrides; the settings file remains the durable default. Pi's
native argument completion offers the subcommands, config keys, and `on`/`off`
values from the same grammar used for parsing and usage help.

Private append-only materializations mirror Session paths beneath
`~/.pi/agent/rarebit/materializations/`; short-lived cross-process job leases
live beneath `~/.pi/agent/rarebit/jobs/`. They retain no raw selected prose,
prompt, provider response body, headers, or credentials.
Directories are mode 0700; materialization and lease files are mode 0600.

## CLI

```sh
hc-rarebit query --session <exact-path-or-id> --json
hc-rarebit extract --session <exact-path-or-id> --json
hc-rarebit summarize --session <exact-path-or-id> --json
hc-rarebit title --session <exact-path-or-id> --json
```

`query` is metadata-only. `extract` returns raw selected Rarebit evidence on
demand from native Session JSONL. Normal `summarize` and `title` call a stripped
ephemeral Pi print process with the same declared `rarebit.model`, Pi auth, and
provider configuration; they load no extensions, tools, skills, context files,
or Session. `--model-command` is an explicit advanced adapter override. The
CLI title returns a date-prefixed proposal and never mutates a Session label.
