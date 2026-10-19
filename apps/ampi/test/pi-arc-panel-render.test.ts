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

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects.
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	page = (await vite.ssrLoadModule("/src/views/cos/Arcs.tsx")).ArcPageView;
	panel = (await vite.ssrLoadModule("/src/views/cos/ArcPanel.tsx")).ArcPanelView;
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
	const stale = /<p class="cos-notice" role="status">[^<]*Build arc to cover (?:them|it)\.<\/p>/.exec(html)?.[0] ?? "";
	const tree = /<section aria-label="Evergreen context">[\s\S]*?<\/section>(?=<\/div>|<p class="cos-headline"|<section aria-label="Projects")/.exec(html)?.[0] ?? "";
	return stale + tree;
}

test("arc panel parity: the Session panel and the Arc page render the same stale line and tier-2 tree", () => {
	const v = value({});
	const a = tier2(renderToStaticMarkup(createElement(page as never, props(v))));
	const b = tier2(renderToStaticMarkup(createElement(panel as never, props(v))));
	assert.match(a, /Covered up to .+ · 2 newer messages or compactions\. Build arc to cover them\./);
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
