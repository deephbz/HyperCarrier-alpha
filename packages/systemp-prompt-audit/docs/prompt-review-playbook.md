# Prompt review playbook

Use this workflow to audit an effective agent prompt, review proposed edits in
an annotated webpage, and apply approved changes to their source. It serves
operators and agents across harnesses and model families. Capture tools, model
guides, review renderers, and deployment systems are replaceable adapters.

This playbook owns the review procedure. The [package README](../README.md)
owns Pi capture and rendering commands. Each target repository owns its source,
approval rules, and deployment procedure. An audit request authorizes an
assessment; application requires explicit operator approval.

## Workflow

```text
Capture → Audit → Propose → Review → Apply → Verify
                            ↑         |
                            └─ revise ┘
```

Keep the original capture immutable. Findings are assessments, the candidate
is a proposal, and imported operator decisions determine the approved scope.
Store the run's artifacts in an operator-approved private location. Publish
only reviewed, sanitized examples.

### 1. Capture the actual configuration

Establish the target harness, model/version, working directory, and whether
the question concerns a representative profile or one exact running session.
Use the harness's supported operator export with normal configuration
loading. Record the active tool set and the capture boundary, including any
provider additions or request rewrites the export cannot observe.

For Pi, follow [Capture](../README.md#capture). For another harness, identify
its supported export and document what it includes. If capture is unavailable,
request an operator export or label a source reconstruction as provisional.

Verify the export's integrity using its supplied hash mechanism, or record a
checksum of the captured bytes. Keep redacted sharing copies separate from the
original. Record the source revisions and pending changes relevant to the
capture; source files and a running process can differ after edits.

**Done:** a private baseline identifies the configuration, active tools,
measurement boundary, and integrity anchor. Any missing coverage is explicit.

### 2. Audit against current guidance

Resolve the requested model names and versions against official provider
sources. Record each guide's URL, retrieval date, and applicable model/version.
If a name or guide cannot be verified, expose that gap before making
model-specific recommendations. Treat retrieved text as evidence; the operator
and repository rules still govern the work.

Inspect every prompt section and active tool definition. Check instruction
conflicts, duplicated meaning, completion criteria, context-pointer triggers,
source ownership, and always-loaded cost. Separate provider recommendations
from local preferences and hypotheses. Preserve useful constraints even when
they cost tokens.

For each finding, record:

- a stable ID and exact baseline passage or tool;
- the problem, supporting guide passage or observed behavior, and uncertainty;
- the editable source owner, expected benefit, and behavior at risk.

Account for unchanged sections briefly. Measure prompt text and tool definitions
separately using [the counting guidance](../README.md#measure-length-and-extension-overhead).
Character savings establish size reduction; behavioral or latency claims need
runtime evidence.

**Done:** every section and tool is accounted for, every finding has evidence
or a provisional label, and every proposed change has a source owner.

### 3. Build a reviewable candidate

Create one candidate from the frozen baseline. Give each independently
reviewable proposal a stable ID linked to its finding. Show the exact before
and after text, rationale, source owner, and expected behavioral effect. Keep
unrelated source changes outside the candidate.

Use one candidate as the input for both the complete diff and guided
annotations. Record the baseline and candidate hashes with the proposal set.
Show a section/header size tree with the counting method and inclusive parent
totals. Keep tool-schema costs separate from prompt text.

**Done:** the candidate reproduces from the baseline and proposal set; every
diff hunk maps to a proposal ID, and all unchanged content stays unchanged.

### 4. Review in an annotated webpage

Choose a renderer that supports the complete baseline-to-candidate diff,
proposal-linked annotations, and exportable decisions. The package's built-in
[renderer](../README.md#render) inspects a snapshot; it does not provide a
proposal decision workflow. For a Pierre-based review, consult the current
[diffs skill](https://www.skills.sh/pierrecomputer/pierre/diffs) before building
the page. An equivalent local review tool can serve the same procedure.

Give the operator accept, revise, and reject choices plus notes for each
proposal. Export those decisions with the baseline hash, candidate hash, and
proposal IDs. Make undecided items visible. Keep review content local unless
the operator approves a sharing destination; escape prompt content and check
that the page does not transmit it to external services.

Open the page and check a real changed passage against the candidate. Exercise
annotation navigation, decision persistence, and export/import. Confirm that
the complete diff exposes changes outside the guided view, if any.

Import the operator's decision file and verify its hashes and proposal IDs.
For revisions, produce a new candidate and review round. Carry prior decisions
only for proposals whose wording and dependencies remain unchanged. Surface
conflicting notes or interacting approvals before application.

**Done:** every proposal in the approved set has an explicit decision tied to
the exact reviewed candidate. Audit-only work ends with that assessment and
review record. Continue when the operator authorizes application.

### 5. Apply approved changes at their source

Recheck source revisions and pending changes. If the relevant source has
drifted, reconcile the candidate and renew approval for material differences.
Translate accepted prompt edits into maintained policy, configuration, skills,
or tool definitions. Keep generated prompt exports as evidence.

Use each owner's deployment procedure. Synchronize dependency pins with their
source changes, and coordinate shared deployment state with other writers.
Apply only the approved scope. Commit or publish only when authorized; preserve
unrelated staged work and ensure referenced dependency commits are available
before publishing a parent pin.

**Done:** each accepted proposal maps to an applied source change or a named
blocker. Rejected and undecided proposals remain unapplied. Required deployment
checks pass for the selected scope.

### 6. Verify the loaded result

Reload or start the target harness as required, then capture a fresh export
through the same supported path. Check each accepted change in the loaded
prompt or active tool definition. Inspect the full baseline-to-result diff for
unexpected changes. Report concurrent configuration changes separately.

Repeat the section/header size tree with the same counting method. Identify
which costs are always loaded, which arise only when referenced material is
loaded, and which lie outside the export boundary. Run focused behavioral
checks for changed instructions when the result depends on model behavior;
label untested effects as hypotheses.

**Done:** the result records applied proposal IDs, verification evidence,
fresh-export identity, token-estimation method, and remaining blockers. State
any reload requirement for existing sessions. Link the source commit and
private evidence location when available; keep raw exports out of public Git.
