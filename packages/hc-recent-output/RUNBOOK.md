# Recent-output runbook

Install/load the package as a Pi package; its manifest loads `src/extension.mjs`
and pins the runtime `@earendil-works/pi-ai` contract to `0.80.6`. Configure
`HC_PROJECT_ID` (or pass `projectId`) before enabling provider calls. The
optional `HC_RECENT_OUTPUT_PATH` or `outputPath` overrides the project-scoped
sink when needed.
For direct Node use, inject a `modelClient`. Keep the sink outside Pi Session
directories and protect it as private local evidence.
Confirm that successful `recent-output-v2` records contain no physical newline
inside `summary` and contain each of the four ordered labels exactly once.

To inspect a record without changing it:

```sh
stat -f '%Sp %N' ~/.local/state/pi-session-timeline/<projectId>/recent-output.jsonl
tail -n 1 ~/.local/state/pi-session-timeline/<projectId>/recent-output.jsonl | jq .
```

`status: "insufficient_window"` means fewer than `N` eligible final messages
were available; `status: "failure"` preserves a retryable model/client error;
`status: "conflict"` preserves a second successful materialization for the
same input identity. Neither status is evidence of runtime liveness, delivery,
priority, or intervention. Inspect `<sink>.quarantine` after a tail recovery.
