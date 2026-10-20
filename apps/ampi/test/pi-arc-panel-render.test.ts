import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { ArcValue } from "../src/pi/views/cos-arc.ts";
import type { ArcContext, ContextLeaf } from "../src/pi/views/cos-arc-context.ts";

// Renders the Arc page and the Session view's Arc panel from one value through Vite's SSR loader (the web code is
// browser TSX), then compares their tier-2 sections. A second renderer would make the two drift.

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let page: (props: object) => unknown;
let panel: (props: object) => unknown;
let dateTime: (t: string) => string;

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects.
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	page = (await vite.ssrLoadModule("/src/views/cos/Arcs.tsx")).ArcPageView;
	panel = (await vite.ssrLoadModule("/src/views/cos/ArcPanel.tsx")).ArcPanelView;
	dateTime = (await vite.ssrLoadModule("/src/views/cos/data.tsx")).dateTime;
});
after(async () => { await vite?.close(); });

const S = "devbox/pi:sess-a";
const cite = (entryId: string, at: number) => ({ session: S, entryId, chunkHash: "h0", at });
const leaf = (text: string, ids: string[], extra: Partial<ContextLeaf> = {}): ContextLeaf => ({ text, citations: ids.map((id, i) => cite(id, 1_760_000_000_000 + i)), ask: false, kind: null, resolvedBy: [], ...extra });
const context: ArcContext = {
	asOfEntryId: "a2", asOfRarebitCount: 4, rarebitFingerprint: "f".repeat(64),
	needsYou: [leaf("Approve the deploy", ["u2"], { ask: true, kind: "approval" }), leaf("Pick a cache cap", ["u1"], { ask: true, kind: "decision" })],
	threads: [{ label: "Cache", state: "active", progress: [leaf("Cap set to 64 MB", ["a2"])], decisions: [leaf("Use LRU", ["a1"], { ask: true, kind: "decision", resolvedBy: [cite("a1", 1_760_000_000_500)] })], blockers: [] }],
	unassigned: { progress: [], decisions: [], blockers: [leaf("CI flaky", ["a1"])] },
	coverage: { evidenceEntries: 4, citedEntries: 4, omittedEntries: 0 }, builtAt: "2026-10-19T00:00:00.000Z", model: "provider/m",
};
const value = (over: Partial<ArcValue>) => ({ title: "Demo", chunks: [{ id: "c0" }], cards: [], transitions: [], coverage: { labelledChunks: 0, excludedEntries: 0, synthesisCurrent: false }, buildEstimate: { inputTokens: 1234, calls: 3, truncatedChunks: 0 }, notice: "", source: null, synthesis: null, job: null, context, contextStatus: { newMessages: 2, branchChanged: false }, ...over }) as unknown as ArcValue;
const build = { pending: false, failure: "", start() {} };
const props = (v: ArcValue) => ({ host: "devbox", threadId: "pi:sess-a", value: v, stale: false, build });
/** The stale line plus the Evergreen context section, as each surface renders them. */
function tier2(html: string): string {
	const stale = /<p class="cos-notice" role="status">[^<]*(?:Build arc to cover (?:them|it)\.|Next automatic update ≈[^<]*)<\/p>/.exec(html)?.[0] ?? "";
	const tree = /<section aria-label="Evergreen context">[\s\S]*?<\/section>(?=<\/div>|<p class="cos-headline"|<section aria-label="Projects")/.exec(html)?.[0] ?? "";
	return stale + tree;
}

test("arc panel parity: the Session panel and the Arc page render the same stale line and tier-2 tree", () => {
	const v = value({});
	const a = tier2(renderToStaticMarkup(createElement(page as never, props(v))));
	const b = tier2(renderToStaticMarkup(createElement(panel as never, props(v))));
	assert.match(a, /Covered up to .+ · 2 newer messages\. Build arc to cover them\./);
	assert.match(a, /Needs you <span class="cos-meta">2<\/span>/);
	assert.match(a, /href="#\/h\/devbox\/t\/pi%3Asess-a\?e=u2"/, "a citation links to its entry in the Session");
	assert.match(a, /closed → answered/);
	assert.match(a, /Evidence: 4\/4 Rarebit messages cited[^<]*<\/p><\/section>$/, "the whole tree, through its evidence line");
	assert.equal(b, a);
});

test("arc tree titles: an ask's kind and a thread's state are badges; the longer text and the quote show on expand, not inline (failure: long titles inline)", () => {
	const ask = leaf("Choose a cache cap", ["u1"], { ask: true, kind: "decision", quote: "Should I cap it at 64 MB, or leave it unbounded for now?" });
	const step = leaf("Fixed the reader cache so it…", ["a2"], { full: "Fixed the reader cache so it evicts by size and age", quote: "Cap set to 64 MB." });
	const ctx = { ...context, needsYou: [ask], threads: [{ ...context.threads[0]!, label: "Reader cache", progress: [step], decisions: [] }], format: undefined };
	const html = renderToStaticMarkup(createElement(page as never, props(value({ context: ctx, contextStatus: { newMessages: 0, branchChanged: false, formatChanged: true } }))));
	assert.match(html, /<summary[^>]*><span class="cos-leaf-title">Choose a cache cap<\/span> <span class="badge cos-badge">decision<\/span>/);
	assert.match(html, /<blockquote>Asked: “Should I cap it at 64 MB, or leave it unbounded for now\?”<\/blockquote>/, "the ask's sentence is one click away");
	assert.match(html, /<h3>Reader cache <span class="badge cos-badge">active<\/span><\/h3>/);
	assert.match(html, /<details class="cos-leaf"><summary[^>]*><span class="cos-leaf-title">Fixed the reader cache so it…<\/span>[\s\S]*?<\/summary><p>Fixed the reader cache so it evicts by size and age<\/p><blockquote>“Cap set to 64 MB\.”<\/blockquote><\/details>/);
	assert.match(html, /This tree uses the older long titles\. The next Build arc rewrites them\./);
});

test("arc tree fold: Unassigned and answered asks stay outside the folded threads (failure: Unassigned hid behind the fold)", () => {
	const many = Array.from({ length: 8 }, (_, i) => ({ label: `Thread ${i}`, state: "active" as const, progress: [leaf(`Step ${i}`, ["a2"]), leaf(`Next ${i}`, ["a2"])], decisions: [leaf(`Keep ${i}`, ["a1"])], blockers: [] }));
	const answered = [leaf("Cap at 64 MB?", ["a1"], { ask: true, kind: "decision", quote: "Should I cap it at 64 MB?", resolvedBy: [cite("u2", 1_760_000_000_900)] })];
	const html = tier2(renderToStaticMarkup(createElement(page as never, props(value({ context: { ...context, threads: many, answered } })))));
	assert.match(html, /<summary>3 more threads/);
	assert.match(html, /<\/details><section class="cos-context-thread"><h3>Unassigned<\/h3>/, "Unassigned follows the fold, never inside it");
	assert.match(html, /<details class="cos-context-answered"><summary>Answered asks <span class="cos-meta">1<\/span>/);
	assert.match(html, /title="“Should I cap it at 64 MB\?”"/, "the verbatim quote is one hover away");
	assert.match(html, /closed → answered <a href="#\/h\/devbox\/t\/pi%3Asess-a\?e=u2"/, "the stored answer cite links to the owner turn");
});

test("arc tree overtaken: overtaken asks leave Needs you for their own fold, keep their age and cite the owner turn (failure: overtaken asks were hidden or still read as open)", () => {
	const overtaken = [leaf("Tag the release?", ["a1"], { ask: true, kind: "decision", closed: "overtaken", resolvedBy: [cite("u2", 1_760_000_000_900)] }), leaf("Rotate keys?", ["a3"], { ask: true, kind: "decision", closed: "overtaken", resolvedBy: [] })];
	const html = tier2(renderToStaticMarkup(createElement(page as never, props(value({ context: { ...context, overtaken } })))));
	assert.match(html, /Needs you <span class="cos-meta">2 · 2 overtaken<\/span>/, "the head counts overtaken asks next to Needs you");
	assert.match(html, /<details class="cos-context-overtaken"><summary>Overtaken asks <span class="cos-meta">2 · /);
	assert.match(html, /Tag the release\?<\/span> <span class="badge cos-badge">decision<\/span> <a [^>]*>\[#a1\]<\/a><span class="cos-meta"> · asked [^<]* ago<\/span><span class="cos-meta"> · overtaken by <a href="#\/h\/devbox\/t\/pi%3Asess-a\?e=u2"/);
	assert.match(html, /overtaken by a later owner turn/, "an owner turn outside the evidence has no link");
	assert.doesNotMatch(html, /closed → answered <a href="[^"]*e=u2"/, "an overtaken ask never reads as answered");
});

test("arc panel not built: the panel offers Build with the one estimate and renders the page's Not built tree", () => {
	const v = value({ context: null, contextStatus: { newMessages: 0, branchChanged: false } });
	const html = renderToStaticMarkup(createElement(panel as never, props(v)));
	assert.match(html, /<button[^>]*>Build arc<\/button>/);
	assert.match(html, /≈1,234 input tokens · 3 calls/);
	assert.equal((html.match(/input tokens/g) ?? []).length, 1, "one estimate, not one per surface");
	assert.equal(tier2(html), tier2(renderToStaticMarkup(createElement(page as never, props(v)))));
	assert.match(tier2(html), /Not built\./);
});

test("arc panel current: a current receipt shows no Build button", () => {
	const html = renderToStaticMarkup(createElement(panel as never, props(value({ contextStatus: { newMessages: 0, branchChanged: false } }))));
	assert.doesNotMatch(html, /Build arc<\/button>/);
	assert.match(html, /Full Arc page/);
});

test("arc chunk rows: start and end times open the first and last message, and a line marks each label-state change", () => {
	const chunk = (i: number, label: object | null, labelCurrent: boolean) => ({ id: `c${i}`, index: i, hash: `h${i}`, startAt: `2026-10-19T0${i}:00:00.000Z`, endAt: `2026-10-19T0${i}:30:00.000Z`, firstEntryId: `u${i}`, lastEntryId: `a${i}`, firstAsk: `Step ${i}`, lastOwnerEntryId: `u${i}`, ownerTurns: i + 1, entries: 4, toolCalls: 1, where: null, idleBeforeMs: null, compactionEntryId: null, label, labelCurrent });
	const label = { project: "Reader", topic: "Parser", ideas: [] };
	const v = value({ chunks: [chunk(0, label, true), chunk(1, label, true), chunk(2, label, false), chunk(3, null, false)] as never });
	const html = renderToStaticMarkup(createElement(page as never, props(v)));
	const rows = html.split('<article class="cos-chunk"').slice(1);
	assert.equal(rows.length, 4);
	rows.forEach((row, i) => {
		assert.match(row, new RegExp(`class="cos-chunk-start"[^>]*href="#/h/devbox/t/pi%3Asess-a\\?e=u${i}"`), `row ${i} start → first message`);
		assert.match(row, new RegExp(`class="cos-chunk-end"[^>]*href="#/h/devbox/t/pi%3Asess-a\\?e=a${i}"`), `row ${i} end → last message`);
	});
	assert.deepEqual([...html.matchAll(/class="cos-chunk-divider" data-state="(\w+)"/g)].map((m) => m[1]), ["stale", "unlabelled"], "a line only where the state changes");
	assert.match(html, /data-state="stale" role="separator"[^>]*><span aria-hidden="true">stale label from here<\/span>/, "each line names its state as text");
	assert.match(html, /data-state="unlabelled" role="separator"[^>]*><span aria-hidden="true">unlabelled from here<\/span>/);
	assert.match(rows[0]!, /title="1 owner turn"><span aria-hidden="true">□<\/span> 1/);
	assert.match(rows[1]!, /title="2 owner turns"/);
	assert.match(rows[0]!, /title="1 tool call"><span aria-hidden="true">›_<\/span> 1/);
	assert.doesNotMatch(html.slice(html.indexOf('aria-label="Chunks over time"')), />Rarebits<|>Last entry<|→/, "the Rarebits and Last entry links and the arrow are gone");
	assert.match(html, /cos-chunk-legend/);
});

test("arc panel model: the panel's last Build line and the Arc page's Build history both name the Build's model (failure: the model showed only in a tooltip)", () => {
	const run = { trigger: "manual", startedAt: "2026-10-19T00:00:00.000Z", endedAt: "2026-10-19T00:00:09.000Z", state: "done", calls: 4, model: "anthropic/claude-haiku-5-5",
		usage: { input: 9000, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0.012 }, retries: 0, reusedLabels: 0, unlabelledChunks: 0, afterEntryId: null, error: null, errorCode: null };
	const v = value({ builds: [run] as unknown as ArcValue["builds"] });
	const panelHtml = renderToStaticMarkup(createElement(panel as never, props(v)));
	assert.match(panelHtml, /<p class="cos-meta cos-arc-last-build" title="[^"]*anthropic\/claude-haiku-5-5[^"]*">Last Build · Arc built on request · 4 calls · [^<]* · claude-haiku-5-5<\/p>/);
	assert.match(renderToStaticMarkup(createElement(page as never, props(v))), /Builds · last: Arc built on request · 4 calls · [^<]* · claude-haiku-5-5/);
});

test("arc panel split models: a Build row names its label and synthesis models, the tooltip gives each purpose's provider/id, calls and price, and a missing model names its key, file and candidates (failure: the row hid the provider and the synthesis model)", () => {
	const run = { trigger: "manual", startedAt: "2026-10-19T00:00:00.000Z", endedAt: "2026-10-19T00:00:09.000Z", state: "done", calls: 4, model: "anthropic/claude-sonnet-5-5",
		usage: { input: 9000, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0.05 }, afterEntryId: null,
		models: { labels: "magpie/claude/claude-haiku-5-5", synthesis: "anthropic/claude-sonnet-5-5", context: "magpie/claude/claude-haiku-5-5" },
		usageByPurpose: { labels: { calls: 2, cost: 0.01 }, synthesis: { calls: 1, cost: 0.03 }, context: { calls: 1, cost: 0.01 } } };
	const panelHtml = renderToStaticMarkup(createElement(panel as never, props(value({ builds: [run] as unknown as ArcValue["builds"] }))));
	assert.match(panelHtml, />Last Build · Arc built on request · 4 calls · [^<]* · claude-haiku-5-5 \+ claude-sonnet-5-5<\/p>/);
	const title = /cos-arc-last-build" title="([^"]*)"/.exec(panelHtml)![1]!;
	assert.match(title, /labels: magpie\/claude\/claude-haiku-5-5 · 2 calls · \$0\.01/);
	assert.match(title, /synthesis: anthropic\/claude-sonnet-5-5 · 1 call · \$0\.03/);
	assert.match(title, /context: magpie\/claude\/claude-haiku-5-5 · 1 call/);
	assert.match(title, /Labels and context use models\.arcLabels; synthesis uses models\.arcSynthesis\./);
	assert.match(panelHtml, /title="[^"]*Labels and context use models\.arcLabels[^"]*">Build arc</);
	// A per-Build name that names no model: one sentence, the time, one fix, the capped list; the row names the model,
	// and every listed row is one click away.
	const available = Array.from({ length: 14 }, (_, i) => `p/m-${i}`);
	const lastError = { message: "No model named anthropic/claude-nope-9 (per-Build model, Arc labels and synthesis).", hint: "Change or clear the per-Build model. Available: p/m-0, p/m-1, +12 more.",
		code: "model", purpose: "label", model: "anthropic/claude-nope-9", preflight: true, available, at: "2026-10-19T21:40:00.000Z" };
	const failedRun = { trigger: "manual", startedAt: "2026-10-19T21:39:59.000Z", endedAt: "2026-10-19T21:40:00.000Z", state: "error", calls: 0, model: null, missingModel: "anthropic/claude-nope-9",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, afterEntryId: null, error: `${lastError.message} ${lastError.hint}`, errorCode: "model" };
	const failed = renderToStaticMarkup(createElement(panel as never, props(value({ builds: [failedRun] as unknown as ArcValue["builds"], job: { state: "error", done: 0, total: 0, chunks: 2, toLabel: 0, waitingFor: null, trigger: "manual", lastError } } as Partial<ArcValue>))));
	const alert = /role="alert">([^<]*)</.exec(failed)![1]!;
	assert.match(alert, /^No model named anthropic\/claude-nope-9 \(per-Build model, Arc labels and synthesis\) · \d\d:\d\d( [AP]M)?\. Change or clear the per-Build model\. Available: p\/m-0, p\/m-1, \+12 more\.$/);
	assert.deepEqual([alert.split("claude-nope-9").length - 1, alert.split("Available:").length - 1], [1, 1], "one model mention, one list");
	assert.match(failed, /<details class="cos-models"><summary>All 14 models Pi lists<\/summary><ul>(<li><code>p\/m-\d+<\/code><\/li>){14}<\/ul><\/details>/);
	assert.match(failed, />Last Build · Arc build failed · no model calls · \$0 · anthropic\/claude-nope-9 not found<\/p>/);
	const checking = renderToStaticMarkup(createElement(panel as never, props(value({ job: { state: "running", done: 0, total: 0, chunks: 2, toLabel: 0, waitingFor: "Checking Pi’s models…", lastError: null, trigger: "manual" } } as Partial<ArcValue>))));
	assert.match(checking, /Checking Pi’s models…/);
});


test("arc copy: a pending automatic Build names its time instead of asking for Build arc, on both surfaces (failure: the owner was told to build by hand)", () => {
	const at = new Date(2026, 9, 19, 14, 35).getTime();
	const v = value({ nextAutoAt: at } as Partial<ArcValue>);
	const a = tier2(renderToStaticMarkup(createElement(page as never, props(v))));
	assert.match(a, /Covered up to .+ · 2 newer messages\. Next automatic update ≈[^<]*35/);
	assert.doesNotMatch(a, /Build arc to cover|or compaction/);
	assert.equal(tier2(renderToStaticMarkup(createElement(panel as never, props(v)))), a);
});

test("arc copy: a receipt without a tree says its currency is unknown (failure: it read as never built)", () => {
	const html = renderToStaticMarkup(createElement(page as never, props(value({ context: null, contextStatus: { newMessages: 0, branchChanged: false, unknown: true } }))));
	assert.match(html, /what it covers is unknown/);
	assert.doesNotMatch(html, /Not built\./);
});

test("arc copy: the estimate shows the last Build's price, once (failure: no price beside the estimate)", () => {
	const priced = renderToStaticMarkup(createElement(page as never, props(value({ buildEstimate: { inputTokens: 1234, calls: 3, truncatedChunks: 0, lastInputTokens: 11_800, lastCost: 0.04 } }))));
	assert.match(priced, /≈1,234 input tokens · 3 calls · synthesis rereads the whole Session · last Build: 11,800 input tokens, \$0\.04/);
	const none = renderToStaticMarkup(createElement(page as never, props(value({ buildEstimate: { inputTokens: 1234, calls: 3, truncatedChunks: 0, lastInputTokens: null, lastCost: null } }))));
	assert.equal((none.match(/dollar price unavailable/g) ?? []).length, 1);
	const unreported = renderToStaticMarkup(createElement(page as never, props(value({ buildEstimate: { inputTokens: 1234, calls: 3, truncatedChunks: 0, lastInputTokens: 0, lastCost: null } }))));
	assert.match(unreported, /synthesis rereads the whole Session · last Build: price unavailable\./, "a Build without reported usage still names its price state");
});

test("arc copy: a done Build with unlabelled chunks shows the cause and the next action on both surfaces (failure: the gap was silent)", () => {
	const run = { startedAt: "2026-10-19T00:00:00.000Z", trigger: "manual", state: "done", calls: 4, retries: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: null }, model: null, unlabelledChunks: 2, labelErrorCode: "answer" };
	const v = value({ builds: [run], coverage: { labelledChunks: 0, unmappedChunks: 2, excludedEntries: 0, synthesisCurrent: true }, contextStatus: { newMessages: 0, branchChanged: false } } as Partial<ArcValue>);
	for (const view of [page, panel]) {
		const html = renderToStaticMarkup(createElement(view as never, props(v)));
		assert.match(html, /The last Build left 2 chunks unlabelled: the model’s answer omitted them\. Build arc labels only those chunks again\./);
	}
});

test("arc copy: chunk rules changed shows one relabel notice on both surfaces, the relabel chunk state and the live chunk rule (failure: old labels read as current or the legend lied)", async () => {
	const { CHUNK_RULE } = await import("../src/pi/views/cos-arc-rules.ts");
	const chunk = (i: number) => ({ id: `c${i}`, index: i, hash: `h${i}`, startAt: null, endAt: null, firstEntryId: `u${i}`, lastEntryId: `a${i}`, firstAsk: `Step ${i}`, lastOwnerEntryId: `u${i}`, ownerTurns: 1, entries: 2, toolCalls: 0, where: null, idleBeforeMs: null, compactionEntryId: null, label: null, labelCurrent: false, relabel: true });
	const at = new Date(2026, 9, 19, 14, 35).getTime();
	const v = value({ chunks: [chunk(0), chunk(1), chunk(2)] as never, relabelChunks: 3, nextAutoAt: at } as Partial<ArcValue>);
	const a = renderToStaticMarkup(createElement(page as never, props(v))), b = renderToStaticMarkup(createElement(panel as never, props(v)));
	for (const html of [a, b]) assert.match(html, /Chunk rules changed; one Build relabels 3 chunks\. Next automatic update ≈[^<]*35/);
	assert.equal((a.match(/Chunk rules changed/g) ?? []).length, 1, "one notice");
	assert.match(a, /<article class="cos-chunk" data-state="relabel"/);
	assert.match(a, /data-state="relabel">unlabelled · relabel pending</);
	assert.ok(a.includes(CHUNK_RULE.replace(/&/g, "&amp;")), "the legend states the live chunk rule");
	assert.match(CHUNK_RULE, /12 owner turns, 40k Rarebit characters, or more than 2 h/);
});

test("arc failure beside the kept Arc: both surfaces name the failed call's purpose, model and time, and keep the last valid Arc (failure: only a generic error)", () => {
	const at = "2026-10-19T21:40:00.000Z";
	const v = value({ synthesis: { headline: "Kept headline", model: "anthropic/claude-haiku-4-5", builtAt: "2026-10-19T20:00:00.000Z" }, keptAt: "2026-10-19T20:00:00.000Z",
		job: { state: "error", done: 3, total: 4, chunks: 1, toLabel: 0, waitingFor: null, trigger: "manual",
			lastError: { message: "synthesis reply invalid: missing headline (the reply echoed the prompt)", code: "answer", purpose: "synthesis", model: "anthropic/claude-haiku-4-5", at } } } as Partial<ArcValue>);
	const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	for (const surface of [page, panel]) {
		const html = renderToStaticMarkup(createElement(surface as never, props(v)));
		const alert = /<p class="cos-error" role="alert">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
		assert.ok(alert.includes(`synthesis reply invalid: missing headline (the reply echoed the prompt) · claude-haiku-4-5 · ${time}.`), alert);
		assert.ok(alert.includes(`Showing the Arc built at ${dateTime("2026-10-19T20:00:00.000Z")}.`), alert);
		assert.match(html, /Evergreen context/, "the kept tree still renders");
	}
});

test("arc build waiting for its Session to load: both surfaces say so instead of empty call counts (failure: a partial Session built and read done)", () => {
	const waitingFor = "Waiting for this Session to finish loading: loaded 79% (42 of 52 MB). Build starts when loading finishes; it stops after 2 min.";
	const v = value({ job: { state: "running", done: 0, total: 0, chunks: 2, toLabel: 0, waitingFor, lastError: null, trigger: "manual" } } as Partial<ArcValue>);
	for (const surface of [page, panel]) {
		const html = renderToStaticMarkup(createElement(surface as never, props(v)));
		assert.ok(html.includes(`<p class="cos-notice" role="status">${waitingFor}</p>`), html);
		assert.doesNotMatch(html, /0 \/ 0 calls/);
	}
});

test("arc source failure beside the kept Arc: both surfaces show the loading error and keep the last valid Arc", () => {
	const message = "Loaded 79% (42 of 52 MB) of the Session in 2 min";
	const v = value({ synthesis: { headline: "Kept headline", model: "anthropic/claude-haiku-4-5", builtAt: "2026-10-19T20:00:00.000Z" }, keptAt: "2026-10-19T20:00:00.000Z",
		job: { state: "error", done: 0, total: 0, chunks: 2, toLabel: 0, waitingFor: null, trigger: "manual", lastError: { message, code: "source", at: "2026-10-19T21:40:00.000Z" } } } as Partial<ArcValue>);
	for (const surface of [page, panel]) {
		const html = renderToStaticMarkup(createElement(surface as never, props(v)));
		const alert = /<p class="cos-error" role="alert">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
		const time = new Date("2026-10-19T21:40:00.000Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		assert.ok(alert.startsWith(`Build arc could not load the whole Session. ${message} · ${time}. Showing the Arc built at ${dateTime("2026-10-19T20:00:00.000Z")}. Retry Build arc in a few minutes.`), alert);
		assert.match(html, /Evergreen context/, "the kept tree still renders");
	}
});

test("arc empty answer after a hub restart: both surfaces read the failure from the Build record, keep the Build button and name the kept Arc's time (failure: the reason vanished on restart)", () => {
	const at = "2026-10-20T01:40:00.000Z", keptAt = "2026-10-19T20:00:00.000Z";
	const message = "The Arc answer was empty: it listed no work threads, open asks, progress, decisions or blockers, even after one retry.";
	const record = { trigger: "manual", startedAt: "2026-10-20T01:39:00.000Z", endedAt: at, state: "error", calls: 4, model: "anthropic/claude-haiku-4-5",
		usage: { input: 9000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0.012 }, afterEntryId: null, error: message, errorCode: "answer",
		errorPurpose: "context", errorModel: "anthropic/claude-haiku-4-5", tree: { raw: { threads: 2, leaves: 3, asks: 0 }, kept: { threads: 0, leaves: 0, asks: 0 } } };
	// The kept tree is current, so only the failure keeps the Build button.
	const v = value({ synthesis: { headline: "Kept headline", model: "anthropic/claude-haiku-4-5", builtAt: keptAt }, keptAt, job: null, builds: [record],
		contextStatus: { newMessages: 0, branchChanged: false } } as unknown as Partial<ArcValue>);
	const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	for (const surface of [page, panel]) {
		const html = renderToStaticMarkup(createElement(surface as never, props(v)));
		// A failure read from the history is a status; only a failure of this hub run is an alert.
		const alert = /<p class="cos-error" role="status">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
		assert.doesNotMatch(html, /role="alert"/);
		assert.equal(alert, `The model’s answer was unusable. ${message.replace(/\.$/, "")} · claude-haiku-4-5 · ${time}. Showing the Arc built at ${dateTime(keptAt)}. Retry Build arc; it asks the same model again.`);
		assert.match(html, />Build arc</, "the Build button stays after a failed Build");
		assert.match(html, /Evergreen context/, "the kept tree still renders");
	}
	// No valid kept Arc: the line names none.
	const bare = value({ keptAt: null, job: null, builds: [record] } as unknown as Partial<ArcValue>);
	for (const surface of [page, panel]) {
		const alert = /<p class="cos-error" role="status">([^<]*)<\/p>/.exec(renderToStaticMarkup(createElement(surface as never, props(bare))))?.[1] ?? "";
		assert.ok(alert.includes(message.replace(/\.$/, "")) && !alert.includes("Showing the Arc"), alert);
	}
	// A running Build hides the last failure.
	const running = value({ keptAt, builds: [record], job: { state: "running", done: 1, total: 4, chunks: 1, toLabel: 0, waitingFor: null, lastError: null, trigger: "manual" } } as unknown as Partial<ArcValue>);
	assert.doesNotMatch(renderToStaticMarkup(createElement(panel as never, props(running))), /cos-error/);
	// The history row names an on-view rebuild's cause.
	const rebuilt = value({ keptAt: null, job: null, builds: [{ ...record, trigger: "auto", cause: "rebuilt: the stored Arc was empty" }] } as unknown as Partial<ArcValue>);
	assert.match(renderToStaticMarkup(createElement(page as never, props(rebuilt))), /Automatic Arc update failed · rebuilt: the stored Arc was empty · 4 calls/);
});

test("arc floor copy: below 4 messages both surfaces say there is nothing to summarize yet and keep Build arc; the history row never says built (failure: a one-prompt Session showed a hollow tree or a failure)", () => {
	const record = { trigger: "manual", startedAt: "2026-10-20T01:39:00.000Z", endedAt: "2026-10-20T01:40:00.000Z", state: "done", empty: true, calls: 3, model: "anthropic/claude-haiku-5-5",
		usage: { input: 900, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.002 }, afterEntryId: null, unlabelledChunks: 1 };
	const v = value({ context: null, synthesis: null, keptAt: null, job: null, builds: [record], floor: { min: 4, messages: 2 }, contextStatus: { newMessages: 0, branchChanged: false } } as unknown as Partial<ArcValue>);
	for (const surface of [page, panel]) {
		const html = renderToStaticMarkup(createElement(surface as never, props(v)));
		assert.match(html, /Nothing to summarize yet\. Arcs build automatically after 4 messages; this Session has 2\./);
		assert.doesNotMatch(html, /cos-error|Not built\. Build arc|chunks? unlabelled/, "no failure, no Not built line, no label gap");
		assert.match(html, /<button class="btn[^"]*"[^>]*>Build arc</, "Build arc stays enabled");
		assert.match(html, /Nothing to summarize yet · 3 calls · &lt;\$0\.01/, "the history row");
		assert.doesNotMatch(html, /Arc built on request|role="alert"/);
	}
	// A stored Arc with work threads stays below the quiet line.
	const kept = value({ keptAt: "2026-10-19T00:00:00.000Z", job: null, builds: [record], floor: { min: 4, messages: 2 } } as unknown as Partial<ArcValue>);
	for (const surface of [page, panel]) {
		const html = renderToStaticMarkup(createElement(surface as never, props(kept)));
		assert.match(html, /Nothing to summarize yet\. Arcs build automatically[\s\S]*<section aria-label="Evergreen context">[\s\S]*Cap set to 64 MB/);
		assert.doesNotMatch(html, /role="alert"/);
	}
});
