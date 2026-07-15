# HyperCarrier Alpha projection contract

The Alpha projection is an additive, read-only surface over the canonical HyperCarrier Project
registry. The deployed timeline remains the authority for `/api/snapshot`, and Alpha never adds
summary or source content to that metadata-only response.

Set `PI_TIMELINE_PROJECT_REGISTRY` (or `HC_PROJECT_REGISTRY`) to the canonical registry path. In
this monorepo, copy `config/project-registry.example.json` to an ignored machine-local location and
point the environment variable at it. The timeline reads that file directly and does not copy or
write a registry. The older manifest variables remain compatibility inputs.

## Legacy v1 manifest compatibility

Set `PI_TIMELINE_ALPHA_MANIFEST` (or `HC_ALPHA_MANIFEST`) to a JSON file, or place
`.hypercarrier/project-manifest.json`, `.hypercarrier/projects.json`, or
`hypercarrier.projects.json` in the server working directory.

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "id": "stable-project-id",
      "name": "Human project name",
      "repoRoots": ["/absolute/repo/root"],
      "worktreeRoots": ["/absolute/worktree"],
      "sessionIds": ["explicit-pi-session-id"],
      "summaryPath": "summary.jsonl",
      "eventsPath": "project-events.jsonl",
      "evergreenProposalsPath": "evergreen-proposals.jsonl",
      "evergreenPath": "Evergreen.md",
      "beadsRoot": "/absolute/beads/root"
    }
  ]
}
```

Paths may be relative to the manifest. `schemaVersion` must be exactly `1`; Project IDs must be
non-empty and unique. `sessionSelection.sessionIds` and `taskIds` are optional explicit selectors. A
cwd basename, cwd equality, file name, PID, or timestamp is never used as a Project identity.
Overlapping session, task, cwd, or configured-source associations are ambiguous: Alpha keeps the
Project rows but does not copy the affected value into multiple Projects as exact evidence.

## Canonical registry contract

The canonical registry is a v1 object with `schemaVersion`, `registryVersion`, `projects`, and
optional `correctionProvenance`. Each Project has stable `id` and `name`, `locations` containing
`repos`, `evergreen`, `beadsRoot`, `summaries`, `events`, and `proposalDir`, and `associations`
containing only explicit `sessionIds`, `taskIds`, or configured rules. Paths locate evidence; they
do not identify a Project. With no explicit Session association, runtime remains unknown even when a
cwd matches a repository.

`summaries` are read directly as hc-key-msg-summary JSONL and `events` directly as
hc-project-distill event JSONL. `proposalDir` is read as the distiller's atomic bundle directories
and `metadata.json`; missing metadata/artifacts, malformed metadata, and hash mismatches remain
partial/corrupt diagnostics. A legacy proposal JSONL path remains a compatibility input.

## v1 source records

Summary JSONL accepts `key_message_summary` records with `summaryId`, `projectId` or `sessionId`,
`observedAt`/`validAt`, and only the reported `progress`, `findings`, `questions`, `nextStep`, or
`summary` string fields. Other content-bearing fields, including `value`, are rejected from the
visible projection and recorded as diagnostics. Project event JSONL accepts `project_event` or
`intervention` records with an `eventId`, `projectId`, `eventKind`, time, and an allowlisted
payload. Evergreen proposal JSONL accepts `evergreen_proposal` or `evergreen_revision` records with
revision/base identity, status, owner watermark, and change count/records. Canonical Markdown is
hashed and exposed as revision identity, size, and modified time; its body is never returned.

Beads is read only through exactly:

```text
bd -C <beadsRoot> export --readonly --json
```

The adapter projects issue identity, title, type, status, priority, assignee, timestamps, labels,
dependency IDs/count, acceptance criteria, and delivery fields. It does not read
`.beads/issues.jsonl` and does not invoke an events export. Configured files and Beads roots are
watched through their existing parent/root, and periodic reconciliation refreshes Alpha as well as
the deployed timeline.

Every projected axis and item carries `source`, `observedAt`, optional `validAt`, `freshness`,
`confidence`, `derivation.version` plus inputs, and typed `rawRefs`; displayed identity and
aggregate scalars also carry field-level refs. Missing, malformed, partial, stale, future-dated,
duplicate, conflicting, and command-failed sources remain structured diagnostics. A timestamp more
than five minutes ahead of the observer clock is `unknown` with `ambiguous` confidence. The seven
Project axes are intentionally separate: `runtime`, `keyMessageSummary`, `intervention`,
`eventDelta`, `evergreenDelta`, `workLedger`, and `delivery`; there is no universal Project status.

The checked-in [fixture](../fixtures/alpha/project-manifest.json) demonstrates two Projects in one
repo and one Project across repos. `/alpha?demo=1` renders browser-only synthetic data only when the
user explicitly requests it; a live fetch failure shows an error and never falls back silently.

## Cold-start verification

After starting or restarting the timeline, verify the API and browser route as two distinct
contracts:

```sh
curl -fsS http://127.0.0.1:4330/api/alpha/snapshot | jq '.projects | length'
curl -fsS -H 'Accept: text/html' http://127.0.0.1:4330/alpha | head
```

The `/alpha` SPA route intentionally requires a browser-style `Accept: text/html` header. A bare
`curl http://127.0.0.1:4330/alpha` may receive the API-style 404 and is not evidence of deployment
drift.
