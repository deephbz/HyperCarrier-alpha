# System Prompt Audit

System Prompt Audit captures Pi's effective system prompt and active tool
definitions for operator review. It registers no model-facing tools.

- `/export-system-prompt [OUTPUT.json]` captures the current Pi process.
- `systemp-prompt-audit SNAPSHOT.json [REVIEW.md]` renders deterministic
  Markdown and self-contained HTML without a model call.

For an evidence-based audit, annotated proposal review, or approved source
application, follow the [prompt review playbook](docs/prompt-review-playbook.md).
It covers the full workflow; this README owns the package commands.

## Install

Install the checkout as a Pi package, then reload Pi:

```sh
pi install /absolute/path/to/systemp-prompt-audit
```

```text
/reload
```

The package requires Node.js 22 or newer.

## Capture

Use this command to measure the user's actual Pi profile. A normal `pi` launch
in a temporary directory is sufficient for a representative profile audit;
you do not need to locate a specific existing process. Keep normal extensions,
built-in tools, skills, context files, settings, and model enabled. Record the
working directory because project-local context and settings can change totals.
Use the original process only when its exact Session-specific state matters.

Do not substitute a minimal test process or an SDK/RPC process with
normal profile discovery disabled for the user's setup. Such a capture measures only that
test configuration. Label it explicitly and never report its total as the
user's normal prompt size. An extension being loaded does not prove that its
model-facing tools are active; check the exported active-tool names.

Run the operator command in the normally configured Pi process:

```text
/export-system-prompt
/export-system-prompt .pi/prompt-snapshots/evidence.json
```

The optional argument is one project-relative `.json` path. Without it, the
command creates a unique file under `.pi/prompt-snapshots/`. Existing files are
never replaced.

Capture must run inside the current Pi process because that process owns the
effective prompt and active-tool set. The command records:

- the exact `ctx.getSystemPrompt()` text;
- active tools in `pi.getActiveTools()` order;
- their full definitions from `pi.getAllTools()`;
- capture time, working directory, and provenance;
- a SHA-256 over the exact prompt-and-tools payload.

The snapshot does not include provider scaffolding or later
`before_provider_request` rewrites.

### Measure length and extension overhead

Report system-prompt text, each active tool definition, and their combined
length separately. State the counting method. Character-based token estimates
are not provider tokenization. Exclude export metadata such as `sourceInfo`
from model-context counts, and state the JSON serialization used for schemas.

For an extension comparison, start with the actual-profile export. Distinguish
an observed active tool cost from a projected cost for an uninstalled candidate.
A measured before/after comparison must preserve all unrelated profile inputs,
including the Session working directory. Do not claim that a candidate is
installed merely because its definitions were added to an offline calculation.
Keep raw exports private and preserve their hashes with the derived breakdown.

## Render

Run the installed command from the project that contains the snapshot:

```sh
systemp-prompt-audit .pi/prompt-snapshots/evidence.json
```

From a source checkout, the equivalent command is:

```sh
node ./render-snapshot.mjs .pi/prompt-snapshots/evidence.json
```

An optional second argument selects the Markdown path. HTML uses the same
basename:

```sh
systemp-prompt-audit \
  .pi/prompt-snapshots/evidence.json \
  .pi/prompt-snapshots/human-review.md
```

The defaults are `evidence.review.md` and `evidence.review.html` beside the
snapshot. Rendering verifies the snapshot hash and refuses:

- paths outside the current project;
- snapshots larger than 16 MiB;
- unsupported schemas;
- malformed or duplicate tool definitions;
- existing review outputs.

The CLI prints a JSON receipt with source, Markdown, and HTML hashes. Identical
snapshot bytes and paths produce identical review bytes. Existing files remain
untouched, so a rerun cannot erase annotations.

## Review artifacts

The JSON snapshot is immutable machine evidence. Markdown is the editable human
review document. HTML is a script-free visual projection of the same snapshot.

The HTML has responsive light and dark styles, line numbers, escaped prompt and
tool content, a restrictive content-security policy, and print styles. Each
prompt line also shows a cumulative token estimate. The estimate counts Unicode
characters through that line, includes line separators, divides by four, and
rounds up. It is not provider tokenization.

## Privacy

Snapshots and reviews can contain sensitive instructions and local paths. Keep
`.pi/` ignored. Review artifacts before you copy, commit, or publish them.

## Verify

```sh
npm test
npm run check
```
