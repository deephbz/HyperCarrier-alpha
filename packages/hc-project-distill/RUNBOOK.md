# Project distiller runbook

1. Add or review an explicit registry entry and stable `id`.
2. Read the canonical Evergreen file and calculate its SHA-256 hash.
3. Pass that hash as `--base-hash` (or the registry's explicit
   `evergreen.baseHash`).
4. Run with `--trace` during investigation and inspect `sourceStates` before
   reviewing the proposed Markdown.
5. When broader synthesis is desired, call the library with an injected
   `synthesisClient` and record its prompt/model/input/output/event identities.
   The raw append-only events remain authoritative if synthesis fails or
   conflicts.
   For an operational run, use `--synthesis-pi --synthesis-model
<provider/model> --synthesis-timeout-ms <ms>`; inspect the private metadata
   for exact argv and raw-output provenance.
6. Have the owner audit the atomically published proposal bundle. Copying it
   into canonical Evergreen is a separate human-authorized action and is
   intentionally not implemented here.

`eventWrite` and `proposal` are independent outcomes. Retry only the failed
stage using the same source frontier and base hash. A changed or missing
canonical file returns an explicit rejection; do not bypass that check.
`proposal.status` of `partial` or `corrupt` means an existing artifact was not
trusted and must be handled through the owner-controlled filesystem workflow.
