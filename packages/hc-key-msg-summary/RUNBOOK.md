# Key Message Summary runbook

Set Pi's normal `defaultProvider` and `defaultModel` in global settings (or in
trusted Project settings). Key Message Summary inherits those settings; it does
not own a second provider/model preference. Verify the sidecar is private and
inspect only metadata and derived output:

```sh
stat -f '%Sp %N' ~/.pi/agent/session-summaries/<cwd-key>/<session>.jsonl
tail -n 1 ~/.pi/agent/session-summaries/<cwd-key>/<session>.jsonl | jq .
```

The target path is mechanically derived from the native persisted Session path
by replacing the `sessions` root with `session-summaries`. It does not require
`HC_PROJECT_ID`; Project association is a later registry/timeline join. An
ephemeral `--no-session` Pi run has no durable source path and therefore skips
materialization unless a caller explicitly supplies `outputPath`.

After changing the extension, run `/reload` in an existing Pi Session. The
resulting `session_start` hook schedules the current branch immediately. A
later interactive or RPC user submission schedules another materialization
only after Pi has persisted that user message. Both run in a detached,
single-flight worker, so prompt entry remains available while the model call is
running; multiple triggers during a call coalesce into one latest-branch rerun.
Pressing ESC does not create a checkpoint, and extension-origin input does not
count as a user submission. The aborted `agent_end` hook only clears pending
origin-correlation state; it performs no materialization.

For a branch that crosses the strict synthesis threshold, interactive Pi shows
human-only lifecycle signals: `triggered`, then either `updated` or a generic
failure. They are TUI notifications, not Session messages or agent context,
and they do not lock the input box. A quiet reload can therefore still be
correct when the input is a duplicate, already in flight, or remains below the
threshold.

`triggered` reports Key Message count, requested model, and a visibly estimated
input-token count (`~ceil(prompt characters / 4)`) because no provider receipt
exists yet. `updated` reports only the receipt's provider input/output counts
and reported model when available; otherwise it says `unavailable` and uses
the requested model identity. Never reinterpret the trigger estimate as
billing or provider-reported usage.

`selection_only` means the complete filtered projection was persisted but the
strict `>50` activation policy did not request a model. `unavailable_overflow`
means the full projection exceeded the configured prompt budget; it is an
explicit limitation, never a shortened tail summary. Provider failures are
recorded as retryable failures. The sidecar must not be copied into a Session.

The provider prompt should contain only ordered `role`, `outcome`, and `text`
fields. Content hashes, occurrence/source IDs, timestamps, producer metadata,
versions, and storage lineage belong in the private sidecar, not on the model
wire.
