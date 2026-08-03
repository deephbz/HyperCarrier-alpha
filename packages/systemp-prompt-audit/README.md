# System Prompt Audit

System Prompt Audit captures Pi's effective system prompt and active tool
definitions for operator review. It registers no model-facing tools.

- `/export-system-prompt [OUTPUT.json]` captures the current Pi process.
- `systemp-prompt-audit SNAPSHOT.json [REVIEW.md]` renders deterministic
  Markdown and self-contained HTML without a model call.

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

Run the operator command in Pi:

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
