---
id: tpm-outer-loop
type: procedure
status: review-pending
---

# Outer loop

Read the caller's authorized outside sources. Maintain journal events,
commitments, and account context under the [artifact contract](artifact-contract.md).
Keep the private inventory separate from this reusable procedure.

1. Select `[start, end)` in the caller's time zone. Use the latest integrated
   `outer` run line for `start`. Declare the first-run window explicitly.
2. List items through each registered read operation. Record query and count.
3. Read every item that can change a commitment or account state. Exclude bulk
   items with counts and reasons. Record missing permissions and expired access
   as gaps and owner handoffs.
4. Append anchored journal events on native dates. Open or revise commitments.
   Close a commitment only with an independent receipt. Unreceipted claims stay open.
5. Propose changed area or project context. Preserve conflicts and source times.
6. Write the `outer` run line with source coverage, opened and closed commitment
   counts, corrections, and gaps. Never skip a source silently.
7. Validate with an explicit store root. Submit authorized changes for review
   under caller policy. Preserve unrelated edits.

The loop never pays, orders, replies, cancels, submits, flags, moves, or deletes
outside records. Authentication stays in the owning client or secret store.
The loop never copies credentials, identity documents, or restricted values.
