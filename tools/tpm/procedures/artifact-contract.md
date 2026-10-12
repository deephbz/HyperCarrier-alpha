---
id: tpm-artifact-contract
type: procedure
status: review-pending
---

# Artifact contract

Use this contract for a caller-owned context store. The owner reviews durable
agent proposals. Keep secrets and raw transcripts in their owning systems.

| Artifact | Responsibility | Change rule |
| --- | --- | --- |
| Register | Area, project, and source navigation | Curate pointers |
| Area page | Standing scope and rules | Revise current context |
| Project page | Outcome, current decisions, handoffs | Revise current context |
| Commitments page | Dated obligations and expectations | Close with a receipt |
| Journal | Anchored events and loop run lines | Append; link corrections |
| Thread map | Source-session associations | Regenerate; apply separate owner overrides |
| Lab note | Refined thinking | Revise; link its evidence |
| View | Decision-specific rendering | Regenerate; never use as source |
| Procedure | Loop operations and boundaries | Curate after review |
| Pulse state | Provisional assessments and processed checkpoints | Rebuild outside version control |

Durable Markdown pages have `id`, `type`, and `status` front matter. IDs are
unique within the store. Agent proposals start `review-pending`. The caller
chooses paths, time zone, retention, and source inventory. Conventional store
paths live in `validate.STORE`. Keep exactly one write authority per artifact.

A claim carries a resolvable source anchor or an explicit provisional label.
Separate historical evidence, current context, and assessment. Agent completion
statements require independent receipts before they become settled results.
Conflicts retain both anchors and times. Correct current context without
erasing historical evidence.

Run lines record loop tag, run ID, half-open window, time zone, source counts,
corrections, and gaps. The latest integrated run line for each tag is its durable
integration watermark. Pulse's processed checkpoint cannot advance it.

Money facts and external account records remain with their owning systems.
Store only approved conclusions and pointers. Views cannot create commitments,
ratify context, or act on external systems. Outside effects need owner approval.
