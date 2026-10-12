# Cache Goblin

Cache Goblin owns prompt-cache placement for Pi Messages payloads. It does not
own compaction, routing, transcript edits, or provider cache-hit guarantees.
Status: consolidation and hardening. This package has no compaction dependency.

## Load

Requires Pi 1.1.0 or newer in the 1.x line. Required hooks:
`before_provider_request`, `cache_warming_decision`, and session lifecycle events.
The optional usage log also uses `provider_stream_event`.

```sh
pi -e ./packages/pi-cache-goblin
```

The package exports the extension factory from its root, the pure planner from
`@hypercarrier/pi-cache-goblin/plan`, and the boundary finder from
`@hypercarrier/pi-cache-goblin/system-split`.

## Use

- `/cache` or `/cache status`: show TTL, held pin, and warming eligibility.
- `/cache 5m`: use the default session TTL.
- `/cache 1h`: use a one-hour session TTL.

A **prefix** contains all request content through a marker. A **pin** holds one
message-block prefix across later requests. Placement preserves raw text and
content. It adds cache controls, removes old controls, and can split system text
without changing its characters. It does not summarize or truncate anything.

```text
[tools][global system] G [project system] P [messages ... held pin ...] T
                       1h                 1h              session   session
```

The planner uses at most four markers. The tail marks the last eligible
non-assistant content block. A new pin shares the tail marker on its first
request. A held pin uses a separate marker when the tail advances. Pins expire
when their prefix or request head changes. The fingerprint includes unknown
request-head fields. It excludes stream mode, output cap, and cache controls.

`5m -> 1h` can rewrite the entire session prefix at the provider's one-hour
cache-write rate on the next request. It does not upgrade an existing five-minute
entry for free. System layers already use one-hour writes. Cache minimum sizes,
pricing, capacity, and cache hits remain provider concerns.

## Cooperate

Use Pi's in-process event bus. Each session holds at most one pin.

```js
pi.events.emit("cache-goblin:pin", { name: "checkpoint" });
pi.events.emit("cache-goblin:unpin", { name: "checkpoint" });
pi.events.on("cache-goblin:placed", (placement) => {
  // { model, ttl, replay, markers, pins, warming }
});
```

`pin` replaces the held pin. A nonempty string name is required. It captures the
tail of the next supported request with an output cap above one token. `unpin`
releases only the matching name. Placement reports pin status and coordinates;
it proves local layout, not HTTP success or a cache write. One-token requests
never capture pending pins. Replay uses the last real request's TTL and pin
snapshot, so a TTL change does not rewrite an in-flight warmer replay.

Session start, replacement, and shutdown clear pins, replay state, and the
command-selected TTL. The configured initial TTL applies again.

## Warming and route limits

The extension leaves Pi's warming economics and warming mode unchanged when
native five-minute warming is eligible. Eligibility requires a matching physical
Messages selection, a declared 300-second short lifetime, a native five-minute
tail marker, and no ambient `PI_CACHE_RETENTION=long`. One-hour policy, TTL
changes, routed selections, unknown native retention, and retention mismatch stop
warming. Status and placement events show the reason. This conservative policy
can skip a safe refresh. It does not force refresh calls or change Pi settings.

Pi 1.1 exposes only the payload at the request hook. `ctx.model` can name a
virtual selection. Placement therefore recognizes the Messages payload shape
without gating on `ctx.model`. OpenAI, Bedrock, Google, malformed payloads,
unknown content types, and Messages requests without a recognizable system field
pass through unchanged. They produce no `placed` event. A custom protocol with
an identical Messages shape cannot be distinguished by this hook. Its provider
must honor Messages cache controls. Provider headers and per-call retention
options are unavailable here. Custom integrations that override retention must
keep the declared short lifetime and native payload controls consistent, or
disable native warming.

The global boundary follows recognizable Pi sections. Installed Pi 1.1 puts
ordinary global and project AGENTS files in `project_context`. The global marker
includes leading files whose paths occur in the configured global path set. The
installed-runtime proof checks two synthetic Projects with identical tools and
global AGENTS. Their provider prefixes through this marker match byte-for-byte.
Each prefix includes global instructions and excludes project instructions/cwd.

Optional `appendSystemPrompt` appears in `addendum` before `project_context`.
Cache Goblin stops the global prefix before an unknown addendum. Global AGENTS
files after that addendum cannot join the shared prefix. This layout does not
meet the full global-AGENTS sharing goal. The extension does not reorder content
or infer that appended text is global. Forced prompts without a known boundary
receive one system marker.

## Configure and verify

- `PI_CACHE_TTL=5m|1h`: initial TTL. Default: `5m`.
- `PI_CACHE_GLOBAL_FILES`: colon-separated global context paths.
- `PI_CACHE_GOBLIN_LOG`: optional local JSONL placement and raw usage log.

The log contains no prompt text. Names, model IDs, prefix hashes, and usage can
still be sensitive. Store it outside public source. Log write errors fail open.

```sh
cd packages/pi-cache-goblin
npm test
npm pack --dry-run --ignore-scripts
```

Tests use synthetic payloads and a Pi event harness. The optional installed
runtime proof uses the actual Pi 1.1 loader, prompt builder, and Messages converter
with a local SDK client. Set `PI_CACHE_GOBLIN_PI_MODULES` to that installation's
`node_modules` directory to include it in `npm test`. The test saves exact
synthetic captures under the worktree's `.scratch` directory. It skips when the
variable is absent. Tests make no paid calls. They do not establish provider
billing behavior or live cache hit rates.
