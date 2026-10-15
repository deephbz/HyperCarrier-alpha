# Tool-prefix counterexamples

`pre-fix-ready.json` and `pre-fix-planner.json` record two real outgoing
requests from seed 37 on Pi 1.1.0. Source: HC `258fc55489f23647fccee9e29167e7a9adb91f5f`.
The Auto Compact implementation at that revision still changes active tools.
The harness includes the repaired checker and documented magpie gateway profile.

Each request includes its completed outcome. The minimal witness changes one
tool declaration between two requests. The full scenario also makes a third
request after readiness removal or planner deselection.

Replay the scenario against the current implementation:

```sh
node packages/hc-auto-compact/sim/repro.mjs --writer ready
node packages/hc-auto-compact/sim/repro.mjs --writer planner
node packages/hc-auto-compact/sim/repro.mjs --writer ready --mutant
node packages/hc-auto-compact/sim/repro.mjs --writer planner --mutant
```

The first two commands must pass after the fixed-inventory repair. The mutant
commands must exit 1 on `stable-cache-prefix`. No native gateway capability flag
is required or enabled. Structural cache evidence does not prove billed hits.
The recorded wall time is one local measurement; it is outside replay identity.

`refusal-guidance.json` records native and foreground-summary wrong-tool calls
on the real controller at `d10442e`, then on the phase-aware wording repair.
Each request follows the wrong call and contains its tool result. The before
text reports no pending work. The after text names the correct tool. Both runs
retain the pending lifecycle and complete through the correct tool without a
forced fallback. This trace shows a guidance defect; it does not show that a
live model would recover from the old wording. Run `sim/wrong-tool.test.mjs`
on either Pi root to verify corrected requests, results, installation, and the
stable handoff prefix on default Anthropic and magpie profiles.

Live canaries still required: Claude Opus through magpie must not loop after an
idle request to compact. A forced foreground plan must recover when steering
asks for `auto_compact_ready`. Scripted replies do not prove model judgment.
