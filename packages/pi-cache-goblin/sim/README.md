# Cache Goblin simulator

Stage: consolidation. This lane verifies real Cache Goblin in real Pi through
`@hypercarrier/pi-sim`. It owns scenarios and independent request monitors.
Provider billing, token minimums, gateway forwarding, and cache availability
remain outside its scope. Architecture impact: none.

## Property catalog

| Property | Failure detected | External anchor |
| --- | --- | --- |
| G1 global sharing | Project text enters the shared global prefix | Two real Pi prompt builds for distinct synthetic Projects; identical tools/global prefix, different project suffix |
| G2 runtime TTL | `/cache` changes status but does not change outgoing marks | Captured Messages tail uses selected 5m/1h TTL; system layers stay 1h |
| G3 held A | Background fork or post-A request loses the A breakpoint | Real Auto Compact fork and outgoing post-A request match all structural blocks through A; compaction entry installs |
| Marker legality | Invalid count, order, placement, or native controls remain | Harness documented Anthropic rules; all outgoing requests checked |
| Provider scope | Goblin edits unsupported protocol payloads | Paired real Pi runs with/without Goblin across Responses, Chat, Gemini, Vertex, Converse |
| Magpie profile | Advisory gateway support is presented as a passing cache gate | Real models.json profile: default tool transition fails; native client flags yield passed=null; Chat opt-in cannot enable Messages placement |
| Tool transitions | Tool change invalidates a live cached prefix | Real Pi tool activation; safe native transition passes, compat mutant fails |
| Branch navigation | A stale pin survives changed branch history | Real Pi navigateTree; prior finalized entries preserved; stale pin absent |
| TTL expiry | Expired tail is treated as a live cache entry | Virtual clock crosses both cache lifetimes |
| Replay | Same seed produces different request history | Repeated normalized traces; UUID identity joins preserved by harness normalization |

Exhaustive small tables cover TTL and provider family. Fast-check generates TTL
commands, pin timing and elapsed time. The campaign increases that bound.
Mutants run after real Goblin placement: wrong tail TTL and removed held pin.
Two-request synthetic replay files define their minimal scenarios. Mutant
failures carry outgoing requests and a named property.

```sh
npm --workspace @hypercarrier/pi-cache-goblin test
npm --workspace @hypercarrier/pi-cache-goblin run test:sim
npm --workspace @hypercarrier/pi-cache-goblin run test:sim:campaign
# Use the deployed Pi root with the same commands:
HC_PI_SIM_PI_ROOT="$HOME/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works" npm --workspace @hypercarrier/pi-cache-goblin run test:sim
```

`HC_PI_SIM_EVIDENCE` writes reports after each world closes. Reports contain
synthetic requests and normalized traces. `HC_PI_SIM_RUNS` sets campaign size.
The script prints Pi version, virtual time, wall time and speed ratio.

Limits: structural matches do not prove billed cache hits. G1/G2/G3 remain
placement and eligibility checks; the paid `verify-pi-cache-goblin` skill owns
billing evidence. Anthropic-compatible gateways share the Messages wire lane;
OpenRouter-compatible Chat shares the Chat lane. Magpie has a first-class real
provider profile. Its default compat exposes the tool-checkpoint cache break.
Client native flags stay advisory because the inspected gateway drops inline
tool additions. These flags are not a deployment fix. Chat ignores the
`X-Magpie-Cache-Marks` opt-in and Goblin applies no Messages policy there.
Raw Bedrock Anthropic is
unsupported by these Pi versions and cannot claim an end-to-end lane. Bedrock,
Google and OpenAI placement stays native; Goblin must leave it unchanged.
Intentional branch/compaction replacement can break a live prefix. Check that
boundary explicitly instead of treating replacement as an append-only turn.
