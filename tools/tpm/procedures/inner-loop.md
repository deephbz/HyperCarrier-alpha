---
id: tpm-inner-loop
type: procedure
status: review-pending
---

# Inner loop

Turn authorized session evidence into anchored journal lines, project context,
handoffs, and thread associations. Follow the [artifact contract](artifact-contract.md)
and caller-maintained [source inventory format](sources.md).

1. Select `[start, end)` in the caller's time zone. Use the latest integrated
   `inner` run line for `start`. Declare the first-run window explicitly.
2. Locate candidates with the owning catalog tool. Record role and scope.
   Keep automated and unsupported sources visible in coverage.
3. Read every candidate that can change a claim. Readers write redacted extracts
   to caller-selected owner-only scratch. Record projects, events, decisions,
   handoffs, receipts, reported outcomes, and state at the cutoff.
4. Reconcile coverage: candidates = kept + excluded. Record each exclusion reason
   and each gap. Check extracts against original entries. Verify claimed settled
   outcomes through the owning system. Self-reports and summaries stay provisional.
5. Associate threads by explicit evidence. Apply owner overrides last. Leave
   uncertain associations unresolved; do not equate a working directory with a project.
6. Append journal events on their native dates. Propose current context and
   handoffs. Write the integrated `inner` run line only for the covered window.
7. Run the caller-configured validator with its explicit store root. The
   [usage contract](../README.md) gives a source-checkout example. Submit only
   authorized store changes for owner review. Preserve unrelated edits and
   follow caller commit policy.
8. Remove prior scratch only under the caller's retention policy.

[Pulse](pulse-loop.md) can locate changed threads. Resolve its anchors before
integration. Its synthesis is an assessment and cannot serve as source evidence.
