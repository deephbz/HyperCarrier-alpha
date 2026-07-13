# `@hypercarrier/hc-project-distill`

This is a separate CLI/library for a bounded Alpha Project distillation pass.
It requires a canonical HyperCarrier v1 registry with explicit stable Project
IDs. The calling deployment owns that registry and passes its path instead of
copying it into this package; the public quickstart uses the ignored
`config/project-registry.local.json`. A repo or Markdown path is only a
location; no ID is derived from cwd, repo basename, timestamps, or Beads IDs.

The registry uses `locations.repos`, `evergreen`, `beadsRoot`, `summaries`,
`events`, and `proposalDir`, and `associations` contains only explicitly
configured Session/Task IDs or rules. `registryVersion` and
`correctionProvenance` are retained in the loaded registry and distillation
trace. Older direct library fixtures using `repo`, `beadsCwd`, and singular
source paths remain accepted as compatibility inputs.

The adapters read:

- Beads using `bd --readonly --json export`; no passive `issues.jsonl` fallback
  exists.
- Git HEAD, dirty status, recent history, and diff.
- Narrow recent-output JSONL sidecars.
- Canonical Markdown and explicitly listed source documents.

The result appends duplicate-safe Project event JSONL and atomically publishes
a proposed Evergreen bundle directory containing Markdown, patch, and metadata
with content hashes against an explicit base hash. It never accepts or
overwrites canonical Evergreen. Event append and proposal generation are
separate retryable stages. Existing bundles are hash-verified; partial or
corrupt bundles are reported rather than reused. A final canonical read is
performed at publication and an owner edit moves the bundle to explicit
`.stale-*` state.

Library callers may inject a separate `synthesisClient` for broader Evergreen
synthesis. That agent receives only deterministic Project events and their raw
source references; it does not replace or mutate the append-only events. Its
proposal section carries exact prompt, model, input, raw-output, normalized-
output, and event identities under explicit `Observed`, `Inferred`,
`Hypotheses`, and `Uncertainty and questions` labels. Without an injected
client, the existing deterministic proposal path remains unchanged.
Observed, inferred, and hypothetical synthesis claims are checked against the
exact input event IDs. Missing or unknown citations make the synthesis
`partial` with structured citation diagnostics in the private proposal bundle;
prompt compliance alone is never treated as verification.

The runnable operational adapter invokes installed Pi in ephemeral print mode:

```sh
node packages/hc-project-distill/bin/hc-project-distill.mjs \
  --registry /absolute/project-registry.json \
  --project stable-project-id \
  --base-hash <audited-sha256> \
  --synthesis-pi \
  --synthesis-model openrouter/z-ai/glm-5.2 \
  --synthesis-timeout-ms 120000
```

The adapter uses `--print --no-session --no-tools --no-extensions --no-skills
--no-prompt-templates --no-context-files` with a fully qualified model and a
bounded timeout. Exact non-prompt flags, a full-invocation hash, prompt hash and
byte count, and raw model output remain in the private proposal metadata; the
prompt itself is not duplicated into argv provenance. Normal CLI output exposes
only status, identities, citation diagnostics, and safe operational provenance.

Project IDs must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. Generated
frontmatter serializes string values as YAML-safe JSON strings. Event and
proposal sinks verify/chmod private directories, reject symlinks, and quarantine
truncated JSONL tails. Beads and Git commands run in detached process groups;
timeouts escalate from TERM to KILL and await the complete tree.

```sh
node packages/hc-project-distill/bin/hc-project-distill.mjs \
  --registry packages/hc-project-distill/examples/registry.example.json \
  --project project-alpha --base-hash <audited-sha256> --trace
```

The library result always exposes structured `sourceStates`; use `trace: true`
to expose raw adapter inputs and derived events. Failures are reported as
`missing`, `source_unavailable`, `malformed`, or `partial`, never silently
converted into complete Project truth. Canonical Evergreen must exist before a
proposal can be `proposed`.
