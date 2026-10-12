---
id: tpm-source-format
type: procedure
status: review-pending
---

# Source inventory format

The caller owns a private source inventory. Use one section per authorized
source. This document defines its format; it contains no account inventory.
Discovery and harness parsing stay with their owning adapters.

```text
Source: example-session-source
Authority: owning trace reader
Scope: authorized human-facing sessions
Read operation: caller-configured read-only command
Native time field: message timestamp with offset
Anchor: authority + session ID + entry ID
Window semantics: [start, end), caller-selected time zone
Evidence class: native transcript; completion statements are reported claims
Known gaps: unsupported branch format remains unavailable
Restricted values: redact before scratch or model input
```

## Native source coordinates

These are source-reading conventions, not new parser implementations. Confirm
format support with the owning reader; report unsupported versions as gaps.

| Source | Native event time | Anchor |
| --- | --- | --- |
| Pi Session JSONL | Entry `timestamp` (UTC) | Session ID + entry `id` |
| Codex rollout JSONL | Native rollout entry timestamp | Thread ID + native entry locator or source line |
| Claude Code JSONL | Entry `timestamp` | Session ID + entry `uuid` |
| Hermes | Session/message native epoch fields | Session ID + message locator when available |
| Scheduled automation | Actual run evidence in target thread | Automation reference + native run entry |
| Rotating screen summary | Declared observation interval | Summary filename; assessment grade only |
| Logseq wrap-up | Native journal/event date | Graph + block UUID, or explicit local `db/id` fallback |
| Mail/account record | Received or transaction date | Owning-system message/record reference |

Source locators, selected accounts, graph names, timezone, access permissions and
adapter commands belong to the private inventory. A settings update is not a
conversation event. A configured schedule is not evidence of a completed run.
Resolve fallback anchors in the original owning system before claiming settlement.

Record selection and serialization versions when the adapter exposes them.
Keep exact session and branch identity. Do not translate identities by guess.
Distinguish append, replacement, omission, and failure. An empty result cannot
establish coverage if extraction omitted input. File modification time locates
candidates; it does not establish conversation recency.

Convert native timestamps at read time. Each coverage ledger records source,
query, window, candidates, kept, exclusions with reasons, and gaps. Require
candidates = kept + excluded. Missing source access stays visible.

Use owning-system receipts above transcript claims. Treat wrap-up lines and
other model summaries as assessments. Resolve important claims through their
original anchors. Keep secrets in their owning systems. Reference sensitive
records without copying restricted values.
