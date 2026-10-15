# Prompt Audit simulator

Stage: consolidation. Architecture impact: none. This lane verifies live Pi
command capture after prompt and tool transitions. Existing unit tests verify
pure export/render behavior with supplied API values. This lane verifies that
the real extension receives current values from real AgentSession command
contexts. Pi loads the real TypeScript extension entrypoint. The harness keeps
transpiler cache writes inside its isolated temporary root. This lane does not
measure the user's normally configured profile.

| ID | Observable property |
| --- | --- |
| A1 | Each snapshot equals the current effective SDK system prompt after a real prompt transition. Provider-only rewrites stay outside the snapshot. |
| A2 | Snapshot tools follow the current active SDK tool order and declarations. Inactive tools stay absent after selection changes. |
| A3 | Export adds no provider request, model-facing tool, or Session entry. Earlier export bytes and Session entries remain unchanged. |
| A4 | The same snapshot produces identical Markdown/HTML review bytes after live transitions. |

Run `npm test` for unit tests and bounded simulation. Run `npm run test:sim` for
this lane alone. Run `npm run test:sim:campaign` for 100 generated scenarios.
`HC_PI_SIM_PI_ROOT` selects another `node_modules/@earendil-works` root.
The shared `@hypercarrier/pi-sim` harness owns the isolated HOME, clock,
scheduler, Entropy, provider wire endpoint, recorder, and replay normalization.

The bounded table covers Anthropic Messages, OpenAI Responses, and a
magpie-shaped Chat profile. The fixture deliberately changes prompt/tool
state. Cache breaks from those fixture transitions are outside this passive
exporter's responsibility. The monitors inspect saved JSON, real SDK state,
wire count, and Session entries. They do not copy the export implementation.
Test-only stale-prompt and stale-tool-selection mutants must fail A1 and A2.
Their seed and minimal action witnesses appear in the test output. Control
and mutant replays compare normalized snapshots, request bodies, Session
entries, and scheduler/Entropy choices. Raw snapshot hashes commit to temporary
root bytes and are validated separately by the real renderer. Replay excludes
those hashes, wall metrics, and UI receipt text.

## Verification receipt

Pi 1.1.0 and 1.2.0 pass nine provider/selection table cases, active-run capture,
both minimal mutants, control/mutant replay, and 100 generated transition
histories at seed 20261015. The final campaigns took 45.97 s and 44.86 s under
concurrent host load. The package check passed nine existing tests and five sim
tests; the default run took about 16.35 s. The root release suite passed all
26 tests before the loader-boundary repair. The repaired harness suite passed
35 tests. No Prompt Audit production bug was found.

A representative two-turn Anthropic scenario ran 120026 virtual ms in 519 wall
ms on Pi 1.1.0 (231x); Pi 1.2.0 used 282 wall ms (426x). Metrics include live
SDK setup and real export/render file I/O. They do not predict provider speed.

No provider credentials or live API calls are required. TUI rendering, actual
profile overhead, provider tokenization, filesystem crashes, and review quality
remain outside this lane. The renderer uses real files inside the isolated root.
