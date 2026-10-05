# pi-ttl-backtester

Status: exploration MVP. Estimated values are labeled as estimates.

Replays local pi session usage under prompt-cache retention policies and
compares each scenario's cost with the actual cost. All costs are public API
prices. Scope: Anthropic and OpenAI model families, whatever route served them
(direct API, `openai-codex`, a local proxy). Other models are excluded, and
their token share is reported.

```
~/.pi/agent/sessions/**/*.jsonl ─ ingest (lineage) ─► rows ─┐
policies.mjs (hard-coded TTL/write terms) ─────────────────┤
pi catalog: anthropic/openai API prices ─► prices ─────────┼─► sim.mjs ─► text table
                                                            └──────────► web view (browser reruns sim.mjs)
```

## Use

In pi:

```
pi install ./packages/pi-ttl-backtester      # or: pi --extension ./packages/pi-ttl-backtester/src/extension.mjs
/ttl-backtest 30d
/ttl-backtest 2026-09-01 2026-09-15 --prices my-prices.json
```

Offline CLI with the same arguments:

```
node packages/pi-ttl-backtester/bin/pi-ttl-backtester.mjs 30d --no-open
```

| Argument | Meaning |
|---|---|
| `[since] [until]` | `7d`, `12h`, `2026-09-01`, or ISO time. Defaults: `7d`, now. |
| `--prices file.json` | Price overrides: `{ "<provider/model>" or "<model>": { "input", "output", "cacheRead", "cacheWrite" } }` in $/M. |
| `--no-serve`, `--no-open`, `--no-index` | Skip the web view, skip the browser, ignore the ingest index. |

The web view answers one question per route: which TTL would have cost least
here, by how much, and on how much evidence. Top to bottom:

1. A verdict card per route, with the setting that selects the cheaper policy
   (`ROUTE_CONTROL` in `src/policies.mjs`) and the evidence behind it.
2. A diagram of the mechanism: a TTL laid against each idle gap.
3. For the selected route: reusable tokens by idle gap; prompt-side cost as a
   function of TTL with the break-even point; the 1h − 5m difference by gap
   band; and a timeline of the turns that decide it.
4. Coverage: in-scope and excluded tokens, and the cost that rests on
   estimated cache writes.

Prices and policies are editable in the page; an edited policy is marked
hypothetical. Design notes: `.scratch/ttl-dashboard-design.md`.

## Policies and scenarios

`src/policies.mjs` hard-codes the provider terms, with source URLs and the
check date. Reconcile it with those pages when a provider changes caching
terms. Base input, output, and cache-read rates come per model from pi's
catalog; run `pi update --models` to refresh it.

| Group | Models | Policies | Write × input |
|---|---|---|---|
| `anthropic` | `claude-*` | 5m (default), 1h | 1.25, 2 |
| `openai-30m` | GPT-5.6 and later | 30m only | 1.25 |
| `openai-legacy` | earlier GPT, o-series | in_memory (5m, conservative), 24h (default) | 1 |

| Scenario | Anthropic | OpenAI |
|---|---|---|
| No cache | none | none |
| Anthropic 5m | 5m | default |
| Anthropic 1h | 1h | default |

OpenAI GPT-5.6 and later have no retention choice, so only the no-cache
counterfactual changes their cost.

## Prices

Each model resolves to its API vendor's catalog entry (`anthropic/…` or
`openai/…`) by normalized id, e.g. `magpie/claude/claude-opus-5-5` →
`anthropic/claude-opus-5-5`, `openai-codex/gpt-6-astra` → `openai/gpt-6-astra`.
Long-context tiers apply per request with pi's `calculateCost` rule. An
in-scope model without an API entry is excluded until you give it a price.

"Actual (logged)" is the cost pi recorded; subscription and proxy routes can
log other values or `$0`. "Actual (API prices)" prices the logged tokens at
API prices.

## Ground truth in the logs

A 30-day audit (`.scratch/ttl-groundtruth/audit.py`) found:

| Route | input / output / cacheRead | cacheWrite | cacheWrite1h |
|---|---|---|---|
| `anthropic` direct | logged | logged | logged (all 0: 5m in use) |
| `openai-codex` | logged | never logged; folded into input | — |
| `magpie` proxy (Claude) | logged | never logged; folded into input | never logged |

- `message.timestamp` is request start. The entry timestamp is response end.
- `parentId` gives exact lineage. 99–100% of lineage pairs grow the prompt by
  at least the previous output.
- Direct Anthropic: on 100% of in-TTL hits, `cacheRead` equals the
  predecessor's `cacheRead + cacheWrite`. After a 5m expiry, the request
  rewrites that prefix.
- Codex and magpie: hits read a median 99.7% of the predecessor prompt.

## Replay model

- A request's predecessor is the nearest earlier assistant request on its
  `parentId` path, on the same model, with no compaction or branch summary
  in between. Its data is used even when it lies before the window.
- The reusable prefix is the predecessor's `cacheRead + cacheWrite` on routes
  that log writes, and the predecessor prompt otherwise.
- Observation wins where it decides the outcome. If the observed read covers
  the prefix, the replay uses it. A short read within the TTL the request
  actually ran under is a prefix change or eviction, and the replay keeps it.
  Only expiry-explained misses are imputed.
- Under TTL T, a request hits when start − predecessor start ≤ T. The other
  prompt tokens are written at the policy's write multiplier.
- Traces can come from any route, including subscriptions; prices are always
  API prices. Subscription and proxy routes (`openai-codex`, `magpie`) report
  no cache writes, so actual cost applies the API's write rule to them:
  uncached input is priced as writes at the route's actual policy. For GPT-5.6+
  this follows OpenAI's docs: the implicit breakpoint is at the end of the
  latest eligible message, so the API writes the whole uncached prompt. For
  Claude, pi marks the last message block, with the same effect. Small
  residuals remain: cold prompts below the 1,024-token minimum are not
  written, and subscription `cached_tokens` rounds down to 128.
- The route's actual policy is the group default, except where
  `ROUTE_POLICY` in `src/policies.mjs` says otherwise. `magpie` Claude uses
  1h: magpie runs `claude -p`, and Claude Code uses 1h for main-conversation
  requests on a subscription (Claude Code docs; local transcripts and a live
  probe wrote 1h only). magpie ignores pi's `prompt_cache_retention`.

Check (30 days, 2026-09-30): replay of each request under its route's
actual policy costs $43.98 (+2.8%) more than actual cost at API prices. All
of that residual comes from requests that read cache after gaps longer than
the nominal TTL ($42.58 Codex beyond 30m, $1.34 direct Anthropic beyond 5m,
$0.07 magpie beyond 1h); the replay counts those as misses. The rest of the
replay reproduces actual cost.

Not modeled: cross-session shared prefixes (e.g. a 2k-token tools block kept
warm by another session), minimum cacheable length, and best-effort retention
beyond the nominal TTL.

## Ingest

- Skips files whose mtime is before `since`, or whose filename start time is
  after `until`.
- Caches parsed rows per file in `~/.pi/agent/ttl-backtester/index.json`,
  keyed by size and mtime.

30 days on this machine (183 files, 21k requests): about 1 s cold, about
40 ms from the index.

## Test

```
npm test
```
