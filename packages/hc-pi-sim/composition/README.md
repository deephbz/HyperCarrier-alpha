# HC extension composition simulator

Stage: consolidation. Scope: the deployed HC extension subset in one real Pi
Session. Architecture impact: none. This lane changes no production contract.
`scenarios.mjs` owns the selected extension order and profile list.

## Run and inspect

```sh
npm --workspace @hypercarrier/pi-sim run test:sim:composition
npm run test:sim
```

`HC_PI_SIM_PI_ROOT` selects the Pi package root. The root command also maps that
selection to each child's standalone SDK-root option. It discovers installed
package `test:sim` scripts, runs each lane, then runs this composition lane.
Detailed logs and `report.json` go to `.scratch/test-sim`; set
`HC_PI_SIM_REPORT_DIR` to choose another result directory.

The table separates documented oracle failures, advisory failures and advisory
limits. Composition emits counts per profile and context epoch. Other lanes
currently emit only test verdicts and selected diagnostics; their aggregate
oracle counts are `n/r`. `suite-ok` is not a cache verdict. Expected mutant
failures belong to successful test runs. The runner does not fabricate zero
counts from those exits. Speed is the maximum reported scenario ratio for that
lane; module startup and host load differ between trials.

## Properties and boundaries

- Load prompt audit, Rarebit, Cache Goblin, Auto Compact, HUD, Blackmagic and
  view-trace in the deployed relative order. External npm extensions are outside
  the HC source bundle and are not loaded.
- Complete two normal turns, display Rarebit, request foreground summary
  compaction, accept the real `compaction_plan` tool and continue once.
- Assert that finalized Session entries remain unchanged and one compaction
  record installs. Real Rarebit and HUD component render functions execute at
  a headless UI boundary. Rarebit must display its native compaction boundary.
- Check tool/system prefix stability through the handoff and validate all
  provider marker constraints. The explicit installed compaction starts a new
  context epoch. Keep the unsplit checker result visible as `rawEpochBreaks`;
  do not mislabel the intended summary replacement as append-only continuity.
- Cover Anthropic, Responses, Chat, Gemini, Vertex, Bedrock and the synthetic
  magpie-shaped default entry. OpenAI/Google cache estimates remain advisory.
  Magpie checks client structure only; translation, retention and billed hits
  remain advisory. No native-transition compat flags are enabled.
- Two test-only writers mutate the tool inventory or system prefix. Both must
  fail `stable-cache-prefix` at request 1 on magpie. Seed 91 replays complete
  normalized request, Session, entropy and scheduler evidence after module
  warmup. Cold module loading can consume different random bytes than a cached
  load. Fresh-process comparison must use two equally cold processes.

PTB loading reaches `child_process.spawnSync` during startup. The host guard
rejects that unmodeled process effect. This lane excludes PTB rather than
weakening the guard or substituting a fake Team. PTB's own simulator and live
Teams remain separate evidence. The default in-memory Session also prevents
Rarebit from treating this as a durable materialization target; its independent
lane owns Summary/Recall filesystem and derivation tests.

The UI boundary runs component code but does not emulate terminal input, ANSI
output, cursor/focus behavior or a Herdr pane. It does not prove visual quality.
Live canaries still need billed cache reads, magpie translation and marker
handling, TUI/Herdr interaction, model summary judgment, and real PTB Teams.
