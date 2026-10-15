# Pi extension simulator

Stage: consolidation. Private workspace package: `@hypercarrier/pi-sim`.
Purpose: find extension request, cache-prefix and lifecycle failures without
provider calls. The harness owns boundary simulation and independent monitors.
Each extension owns its scenarios and mutants. Architecture impact: none to
production contracts.

## Run

From the HC repository root:

```sh
npm --workspace @hypercarrier/pi-sim test
HC_PI_SIM_PI_ROOT="$HOME/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works" \
  npm --workspace @hypercarrier/pi-sim test
npm --workspace @hypercarrier/pi-sim run test:sim:campaign
npm --workspace @hypercarrier/pi-sim run test:sim:composition
npm run test:sim
```

`npm test` runs core conformance without HC sibling imports.
`test:integration` runs HC extension writer checks; `test:sim:composition` runs
HC composition. Root `test:sim` includes all three.

The default suite is bounded. The campaign runs 100 generated real-session
scenarios. `HC_PI_SIM_RUNS` changes that bound. Tests print Pi version, seed,
wall time, virtual time and speed ratio. No provider credentials are needed.
The root `test:packages` script includes this suite.
The [composition lane](composition/README.md) loads the deployed HC subset.
The root `test:sim` command runs installed lanes and prints separate documented
and advisory columns. It labels missing aggregate oracle counts as `n/r`.

## Use from another package

This private package is an R&D dependency. It is not published to npm.
Use the HC workspace or install a local tarball:

```sh
# In this source package:
npm pack
# In the consumer's private test project:
npm install --save-dev /path/to/hypercarrier-pi-sim-0.2.1.tgz \
  @earendil-works/pi-coding-agent@1.2.0
```

Keep this dependency out of independently published runtime artifacts.
Pi resolves from the installed peer by default. `HC_PI_SIM_PI_ROOT` overrides
it with an `@earendil-works` directory containing `pi-coding-agent` and `pi-ai`.
An invalid explicit root fails without fallback. `HC_PI_SIM_PATH`, when used
by a consumer loader, selects the simulator package root; it does not select Pi.

`SIM_API_VERSION` exports the package version. In 0.x, minor releases change the
API contract; patch releases preserve it. Pin an exact version in a private
test manifest. Record the simulator source revision beside test evidence;
workspace links follow the current checkout. A Git revision identifies tracked
simulator source only. An enclosing consumer's Git HEAD is not simulator
provenance.

Node >=22.19 is required. Simulator 0.2.0 was tested on Node 22.19.0,
24.21.0 and 25.6.0 × Pi 1.1.0 and 1.2.0. Simulator 0.2.1 has packed-consumer
evidence on Node 25.6.0 × both Pi versions. Node 24.21.0 is tested at 0.2.0
only until the final 0.2.1 cells are rerun. Other Node versions are unverified.
The Node 24 cells use npm 11.8 for installation. Pi 1.2.0 installs without
sibling overrides.

An npm `min-release-age` setting can block a fresh install of a recently
published Pi. npm 11.19 enforces this setting; npm 10 and 11.8 ignore it.
Runtime conformance does not prove package-age policy compliance.
The smoke never changes user config.
`HC_PI_SIM_NPM_CLI=/path/to/npm/bin/npm-cli.js` selects a specific installer
for reproducible runtime comparisons; each cell records its npm version.

Known upstream issue: Pi 1.1.0 declares `pi-codemode: ^1.1.0`. A fresh
install resolves 1.2.0, which removes `MCP_TYPESCRIPT_PREAMBLE` from the
`declarations` export. Pi 1.1.0 then fails during SDK import. Pin its sibling
stack in the consumer's package.json; the smoke uses these exact overrides:

```json
{
  "overrides": {
    "@earendil-works/pi-agent-core": "1.1.0",
    "@earendil-works/pi-ai": "1.1.0",
    "@earendil-works/pi-codemode": "1.1.0",
    "@earendil-works/pi-mcp": "1.1.0",
    "@earendil-works/pi-tui": "1.1.0"
  }
}
```

The observed incompatible codemode version is 1.2.0 within `^1.1.0`;
later versions are untested. This workaround does not patch Pi.
`npm run test:consumer` packs and installs into fresh temporary projects with
only the declared dependencies and the selected Pi peer. Run it under each
Node version being claimed; it prints Node, Pi, simulator version and source
revision. Other versions in the peer range are unverified.

## Use

```js
import { SimWorld, assertCacheSafe } from '@hypercarrier/pi-sim';

const world = await SimWorld.create({
  seed: 37,
  family: 'anthropic',
  extensionPaths: [new URL('../src/extension.mjs', import.meta.url).pathname],
  compat: {
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
  },
  replies: [{ text: 'ready', delayMs: 25 }, { text: 'done' }],
});
try {
  await world.prompt('first');
  await world.advance(1000);
  await world.prompt('second');
  world.assertHealthy();
  assertCacheSafe(world.requests);
  const { trace, cache, metrics } = world.report();
} finally {
  await world.close();
}
```

`root` selects a stable isolated directory, for example a seed-scoped path under
an isolated test-run parent. It must not exist. Creation is atomic; collisions
fail without deleting existing data. The world removes its owned root on close
or initialization failure. `sessionStorage: 'durable'` stores real native Session
JSONL under `world.sessionDir`; the default is `'memory'`. Durable here means
real files during the world lifetime, not retention after close.

`setup(context)` runs after the host boundary and SDK storage exist, before
extension loading. It can write fixtures and return `{extensionPaths,
extensionFactories}`. These append to the top-level extension lists. Context
contains `root`, `cwd`, `agentDir`, `sessionDir`, `sdk`, `modelRuntime`, `model`,
`sessionManager`, `entropy` and `scheduler`. Async setup uses the same bounded
scheduler as later actions. A setup error restores globals and removes the
owned tree. The consumer owns all extension-specific configuration.

`extensionFactories` accepts inline Pi factories. `extensionPaths` loads real
modules through Pi. `settings`, `model`, `systemPrompt` and `tools` configure
the real SDK. Default resource discovery and automatic compaction are off.
Tests can enable them explicitly. `world.session`, `world.sessionManager` and
`world.modelRuntime` expose the real SDK objects. Use `world.run(() => operation)`
for asynchronous SDK operations outside `prompt()`.
`mode` defaults to `rpc`; `uiContext` overrides the headless UI boundary. The
composition lane selects `tui` and invokes real component render functions.
Terminal input and visual acceptance remain outside that boundary.

A reply can contain `text`, `toolCalls`, `usage`, `delayMs`, `status`, `error`,
`errorType`, `throw` and `stopReason`. Tool calls use `{name, arguments, id?}`.
Usage fields are `input`, `output`, `cacheRead` and `cacheWrite`. They are
scenario inputs. The endpoint does not derive usage from the checker.
A finite `replies` array consumes one item per request; each item can also be
an async function `(request, {entropy, now}) => reply`. Alternatively, pass that
function as `replies` to handle any number of requests. The function receives
a copy of the validated raw request, including `body`, `headers` and `sequence`.
Use shared `entropy` for choices and return `delayMs` for virtual latency.
Request classification and reply text belong to the consumer. A missing reply
or thrown callback fails `assertHealthy()` even if Pi catches the transport
error. Finite exhausted scripts and unconsumed replies also fail. Consumers
with an unbounded function must assert their own expected request count.
Extension errors and swallowed host violations also fail.

`replay({seed, family, compat, replies, actions}, options)` accepts
`{type: 'prompt', text}` and `{type: 'advance', ms}` actions. It attaches the
scenario and trace on failure. `explore(arbitrary, run, {seed, numRuns, path})`
uses fast-check and reports the shrunk counterexample plus replay seed/path.
`assertEntriesPreserved(before, after)` checks finalized Session entry identity
and content independently of Pi's reducers.

## Host-I/O latency injection

```js
import { SimWorld, delayHostIO } from '@hypercarrier/pi-sim';
const world = await SimWorld.create({
  hostIOLatency: delayHostIO({
    operations: ['lstat', 'FileHandle.stat'],
    delayMs: 30,
    path: value => typeof value === 'string' && value.endsWith('/fixture.json'),
  }),
});
// Drive actions with world.run()/world.advance(); close the world in finally.
```

This per-world fault policy delays completion of real filesystem work. It is
not a timing model. Operation names match tracked `fs.promises` functions;
tracked handle methods use the `FileHandle.` prefix. Unknown and unmodeled
operations fail at policy creation. The optional synchronous `path` predicate
receives the first original path argument, or the original open path for a
FileHandle method. Omitting it selects every path for the named operations.

`delayHostIO` returns a reusable selector. A custom `hostIOLatency` function can
also map `{operation, path}` to nonnegative finite milliseconds. Keep selectors
deterministic and free of side effects; do not read a wall clock or use host
randomness. The scheduler evaluates the policy before starting the operation.
It records selected delays as `host.io.delay` without wall-clock timestamps.

The delay uses a real host timer after success or rejection. The entire delayed
completion stays in `pendingIO`; `run()` and `advance()` cannot pass it with a
virtual timer. Their existing wall-time safety bound includes the injected delay.
No setting changes another world or the host API after close. This compatible
API addition uses patch version 0.2.1.

## Boundary and evidence

The real Pi `AgentSession`, extension runner, SessionManager, request builders
and stream parsers run in process. No extension algorithm is substituted.

- One Entropy source controls random bytes, UUID input, `Math.random` and the
  choice among ready scheduler operations.
- One scheduler controls virtual Date/performance time, timers, reply latency
  and scheduled user/fault callbacks. It records each enabled operation set.
- Each world gets a temporary HOME, agent directory, workspace and OS-temp
  directory. Jiti writes its transpiler cache inside that temporary root.
  Inherited Herdr bindings are cleared and restored on close. Source and
  dependency reads can use their original paths. Ordinary path-based writes
  outside the isolated root, symlink creation, subprocesses and sockets fail.
- Fetch accepts only `pi-sim.invalid`. AWS Converse uses Node HTTP instead of
  fetch. Its handler receives the real SDK's serialized request and returns
  binary AWS event-stream bytes. The AWS SDK still parses that response.
- The recorder keeps request bodies, selected protocol headers, response
  outcomes, SDK events, finalized Session entries, UI notifications, entropy
  and scheduler choices. Raw bodies remain available in `world.requests`.
- Worlds run serially per process. Use separate processes for parallel tests.
  `close()` emits shutdown, disposes the Session, restores globals and removes
  the temporary tree.

The default suite exercises text/tool/result round trips through real Pi for
Anthropic Messages, OpenAI Responses, OpenAI-compatible Chat, Gemini, Vertex
and Bedrock Converse. Anthropic-compatible gateways use the Messages family;
OpenRouter-compatible Chat uses the completions family. This verifies wire
contracts, not any gateway's actual cache behavior.

The raw Bedrock Anthropic endpoint emits documented binary `chunk.bytes`
envelopes. It has a boundary-level test only. The tested Pi versions expose
Converse but no raw InvokeModel adapter. `SimWorld` rejects that unsupported
family instead of routing it through a different API.

## Cache oracle

[`src/cache-checker.mjs`](src/cache-checker.mjs) owns the rule registry and
citations. [`src/request-contract.mjs`](src/request-contract.mjs) checks a
bounded request envelope and tool-result joins. Unknown fields remain intact.

The checker measures ordered structural blocks. It tracks explicit cache
breakpoints, TTL, hit refresh, Anthropic's 20-block lookback, marker limits and
TTL ordering. A mutation inside a live protected prefix fails
`stable-cache-prefix`. Expiry explains a miss. A failed request cannot populate
the simulated cache. Cache writes and refresh require `outcome: 'completed'`,
a 2xx `status` and a finite `completedAt`. Request-only records have unknown
outcomes and cannot populate the cache. The recorder distinguishes pending,
completed, aborted, rejected and transport-error outcomes.

OpenAI and Google hidden serialization, automatic retention and hit probability
remain advisory. The checker reports advisory violations separately.
Provider constraints and verification policy have separate authority.
`providerPassed` checks documented provider constraints, such as marker limits.
`policyPassed` checks our `stable-cache-prefix` policy against documented
provider premises. Each violation identifies `authority: 'provider' | 'policy'`,
`evidence` and `source`; policy violations also cite their provider `basis`.
`passed` combines both verdicts. Advisory evidence cannot establish either gate.
Unsupported gateway transitions return `passed: null`, `policyPassed: null` and
`verdict: 'advisory'`. `assertCacheSafe` rejects this incomplete verdict.
`structuralPassed` checks only the absence of structural prefix breaks.
Inspect each assessment's `providerRule`, `prefixPolicy` and `eligibility`, plus
the report's `advisory` list. No verdict promises a cache hit.

Model token minimums, tokenization, hidden server scaffolding, server eviction,
cache routing, explicit Google cache-resource lifecycle and billed usage are
outside this model. An exact shared block prefix is a necessary structural
condition. It is not a token or cost estimate. Provider docs and real probes
must justify stronger claims.

## Magpie-shaped Chat profile

```js
import { magpieProfile, SimWorld } from '@hypercarrier/pi-sim';
const world = await SimWorld.create({
  ...magpieProfile(),
  extensionPaths: [/* real extension paths */],
  replies: [{ text: 'ready' }],
});
// Drive the session and close it as shown above.
```

`magpieProfile({compat, headers, model})` returns the Chat family, the explicit
`gateway: 'anthropic'` cache profile and a synthetic `providerEntry: {id, config}`.
Pi's real `models.json` loader merges provider and model compat. The default
entry enables only session-affinity headers. It does not inject native tool or
system capabilities. Set model and compat inside the helper; do not also set
the world's top-level `model` or `compat` options.

The checker projects Chat tools, leading system content and conversation blocks
in Anthropic prefix order. Anthropic documents that order and exact-prefix
requirement. Our local `stable-cache-prefix` policy rejects the default Pi
checkpoint after tool activation. This is a client structural check. It does
not execute magpie or reproduce its outgoing Anthropic request.

`supportsMidConvoSystemMessages` plus `supportsMidConvoToolAdditions` keep the
client prefix stable. They are **not a fix for the inspected gateway**.
[Its request type and parser](https://github.com/yetone/magpie/blob/122e655aacbb6e26b733ceb786e95dfc9cb57a3c/internal/gateway/chat.go)
drop inline tool declarations and hoist system/developer content. The flags-on
trial therefore returns an advisory verdict. `structuralPassed: true` cannot
establish correct tool execution or effective gateway caching.

`X-Magpie-Cache-Marks: client` is recorded but has no effect on Chat. This follows
the HC `verify-pi-magpie` client-cache-marks procedure. Gateway marks, bridge run
reuse and retention remain advisory. `hitBlocks` uses synthetic retention for
the local prefix policy; it does not predict actual hits. Inspect `gateway` and
`cacheEstimate` on each assessment. Generic OpenAI profiles remain advisory.

## Acceptance and limits

[`test/fixtures/tool-change.mjs`](test/fixtures/tool-change.mjs) registers two
real tools. A command activates the second tool between two real requests.
The safe fixture keeps both Anthropic native-transition capabilities enabled.
Two separate compat mutants disable one capability each. Both must fail
`stable-cache-prefix` at request 1. This proves the two-request failure class;
it does not authorize those flags for a provider that lacks native support.
`test/gateway.test.mjs` runs the magpie-shaped loader path on both Pi versions:
default compat fails, native flags preserve client structure with an advisory
verdict, and the Chat opt-in cannot grant marker authority.

Tests compare raw fresh-process histories after replacing only the temporary
root. Same-process replay additionally alpha-renames UUIDs because Pi owns a
process-global UUIDv7 counter. That comparison preserves identity joins but
cannot prove UUID payload semantics. Keep semantic assertions on raw requests.
Wall-time metrics stay outside deterministic traces.

The scheduler tracks every function-valued `fs.promises` export and drains
pending operations before virtual timers. `run()` and `advance()` share this
rule and the default 15-second wall-time safety bound. `advance()` also drains
work started by its last timer before it returns. It rejects `watch` and `glob` before
creating their unmodeled async iterators. It preserves the existing file
descriptor guards. `fs.promises.mkdtemp` draws six-character suffixes from shared
entropy and creates real mode-0700 directories through the path guard. It retries
collisions up to 100 times. String prefixes and Node output encodings are
supported; non-string prefixes fail explicitly. Callback/synchronous `mkdtemp`
are not deterministic. Handles returned by `fs.promises.open` track `read`,
`write`, `writeFile`, `sync`, `close` and `stat` through the same bounded drain.
The wrappers preserve descriptor ownership checks and restore each handle's
methods on close of the world. Other FileHandle methods are unmodeled.
It also drains bounded promise and Node job checkpoints between choices.
Real source loading and filesystem completion are not instruction-level
simulations. Filesystem crash durability, arbitrary asynchronous host races,
worker threads, inherited file descriptors, native addons and hostile extension
sandboxing are unclaimed. UI methods record notifications/status/widgets and
supply negative dialog answers; terminal rendering is not simulated. Missing
boundary support must remain explicit instead of becoming a passing result.
