---
id: tpm-pulse-loop
type: procedure
status: review-pending
---

# Pulse loop

Pulse maintains provisional progress from selected conversation evidence.
The catalog owner supplies discovery. Rarebit supplies selection. Harness
adapters supply parsing. The context-store owner ratifies durable proposals.
The [README](../README.md) owns command usage and configuration.

1. Choose authorized catalog scope, ingestion and synthesis model commands,
   limits, context files, and owner-only runtime state outside version control.
2. Run one manual cycle with explicit state and configuration paths. Configure
   `refresh_command` if the cycle must refresh the owning catalog first.
3. Inspect run health and `read` output. Check gaps, native evidence times,
   assessment times, and synthesis staleness. Retry failed or pending work;
   checkpoints advance only with valid assessments in the same transaction.
4. Resolve important anchors through the complete source reader. Verify settled
   results through their owning systems. Use the [inner loop](inner-loop.md) for
   durable integration. Keep synthesis provisional until owner review.
5. Enable a trigger only under explicit caller approval. Timing, environment,
   deployment, and schedule lifecycle belong to that caller. A source install
   does not authorize activation or external posting.

Whole-message backfill respects configured input budgets. A replacement,
mutation, or truncation rebuilds without the prior assessment. Oversized messages,
unknown selectors, unsupported adapters, failed commands, and known secret
matches remain gaps. Model-call limits retain failed checkpoints. Changed
context invalidates cached synthesis. No silent truncation is allowed.

Pulse stores hashes, source coordinates, assessments, context paths, and health.
It does not persist selected source prose or prompts. It keeps processed
checkpoints separate from Rarebit human read markers and durable integration
watermarks. Known-pattern screening is incomplete; review egress policy before
sending source evidence to a model. Automatic durable writing is outside scope.
