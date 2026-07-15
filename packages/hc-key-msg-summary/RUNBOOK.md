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
resulting `session_start` hook materializes the current branch immediately;
the next `agent_end` then refreshes it only if the branch changed.

For a branch that crosses the strict synthesis threshold, interactive Pi shows
three human-only lifecycle signals: `triggered`, then either `updated` or a
generic failure. They are TUI notifications, not Session messages or agent
context. A quiet reload can therefore still be correct when the input is a
duplicate, already in flight, or remains below the threshold.

`selection_only` means the complete filtered projection was persisted but the
strict `>50` activation policy did not request a model. `unavailable_overflow`
means the full projection exceeded the configured prompt budget; it is an
explicit limitation, never a shortened tail summary. Provider failures are
recorded as retryable failures. The sidecar must not be copied into a Session.
