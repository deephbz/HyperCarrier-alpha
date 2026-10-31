# Auto Compact simulation

Stage: consolidation. Scope: verification over real Auto Compact, Pi Sessions,
and provider request builders. `@hypercarrier/pi-sim` owns host boundaries.
This lane owns scenarios, independent history checks, and tool-inventory mutants.
Architecture impact: none for simulator coverage; the separate branch-navigation
repair changes the model-facing tool contract.

## Property catalog

| ID | Prediction and independent evidence |
| --- | --- |
| AC1 | Usage below the configured threshold starts no handoff; usage at the threshold starts one. Check native custom entries and outgoing requests. Vary the Session budget. |
| AC2 | Ready, cancellation, and method-selection transitions preserve the declared tool inventory. Wrong-tool refusals name the correct tool and preserve the pending run. Conditional ready and planner declarations break `stable-cache-prefix` on magpie with default Pi compat. Check raw requests, tool results, status, and the harness checker. |
| AC3 | Foreground summary and keepset install the supplied plan, keep ordinary user evidence, and resume once. Native compaction installs the provider summary. Check native compaction entries and request bodies. |
| AC4 | Background planning preserves its captured prefix and installs only after its plan succeeds. Unsupported APIs reject the selection. Check fork requests, native entries, and notices. |
| AC5 | Held inputs enter native history in order after pickup. Handled or failed input remains recoverable. Check user/custom entries and recovery notices. |
| AC6 | Provider failure or abort does not fabricate a successful compaction. An explicit retry can complete. Check summaries, tool results, and notices. |
| AC7 | Finalized entries retain identity and content through compaction and navigation. Check entry snapshots independently of the controller. |
| AC8 | A Session or tree boundary does not carry pending held text into another target. Check native entries and recovery notices. Old custom/budget entries remain readable. |
| AC10 | The `context.budget` slot shows each assistant response's usage and the current settings and Session budget before the turn ends. Check the slot that a tool sees while it runs. |
| AC9 | Same seed and scenario replay the normalized history. Record minimal failing scenarios, request evidence, Pi version, virtual time, and wall time. |

## Run

```sh
npm --workspace @hypercarrier/hc-auto-compact run test:sim
npm --workspace @hypercarrier/hc-auto-compact run test:sim:campaign
HC_PI_SIM_PI_ROOT="$HOME/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works" \
  npm --workspace @hypercarrier/hc-auto-compact run test:sim
```

The bounded lane uses exhaustive small tables and seeded generated scenarios.
The campaign increases generated runs. Mutants stay in `sim/` and reintroduce
conditional tool declarations around real command handlers. Each mutant fails
AC2 with a passing control. The magpie profile loads a real `models.json` with
`sendSessionAffinityHeaders: true` and default Pi compat. Its cache verdict is
a documented local policy. Implicit OpenAI/Google assessments remain advisory.
Bedrock raw Anthropic is unavailable in the tested Pi adapters. The lane must
state unsupported paths rather than substitute a different provider.

Native summary and pickup intentionally replace conversation prefixes. Their
whole-history cache diagnostics can report these resets. AC2 asserts cache safety
only across tool-inventory transitions; this lane does not claim cache continuity
through compaction. Session replacement uses native SessionManager creation,
agent reset, and the real startup hook after abort. It does not simulate the
complete interactive host replacement adapter. Legacy Sessions can contain
branches with an older Auto Compact tool inventory; navigating to one now
restores the fixed Session inventory at that boundary, without per-turn
cache-prefix changes.

The catalog records intended coverage. Test output and named scenario results
establish which paths passed. Rendering, real provider billing, server eviction,
and arbitrary host races remain outside this lane.
