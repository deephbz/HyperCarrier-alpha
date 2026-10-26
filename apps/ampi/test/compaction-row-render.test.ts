import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { CompactRecord } from "@hypercarrier/auto-compact-durable";

// Renders the transcript's compaction row from a synthetic keepset record, a rejected plan, and an old record-less row.

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let row: (props: object) => unknown;

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects.
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	row = (await vite.ssrLoadModule("/src/components/CompactionRow.tsx")).CompactionRow;
});
after(async () => { await vite?.close(); });

const summary = [
	"## Working-state summary (written by you just before compaction)",
	"Goal: rename the parser.",
	"## Tool results you chose to keep (verbatim, captured before compaction — files may have changed since)",
	"### t2 · read {\"path\":\"a.ts\"}\n```\nexport const a = 1;\n```",
	"### t3 · bash {\"command\":\"cat big\"}\n```\nbig-output-head\n```\n[cut at 8000 tokens; 120 more tokens in history]",
	"## Conversation record (user messages and assistant prose, from the full durable history)",
	"- user: rename it",
	"## Dropped tool results (output not in context; repeat a read-only call if needed, never a mutating one)",
	"- ls {} · 12 tok",
].join("\n\n");
const keepset: CompactRecord = {
	method: "keepset", taskId: "task-9", attempts: 1, reason: "threshold", at: 1, replacedEntries: 14, firstKept: 30,
	keep: {
		cap: 20000, perItemTokens: 8000, keptTokens: 8010,
		kept: [{ label: "t2", name: "read", entryId: "21", tokens: 10 }, { label: "t3", name: "bash", entryId: "25", tokens: 8120, cut: true }],
		dropped: [{ label: "t1", name: "ls", entryId: "17", tokens: 12, args: "{}" }],
		droppedCount: 3,
	},
	planner: { model: "magpie/claude-haiku-5-5", requests: 1, usage: { input: 40, output: 300, cacheRead: 9500, cacheWrite: 60, cost: 0.002 }, promptTokens: 9600, cache: "99% of 9600 prompt tokens read from cache" },
};
const entry = { id: "40", kind: "compaction", summary, reason: "threshold", ts: 1000, byTaskId: "task-9" };
const render = (props: object) => renderToStaticMarkup(createElement(row as never, { host: "devbox#durable", threadId: "c1", ...props }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/\s+/g, " ");

test("compaction row: a keepset record names method, kept, dropped and planner cost; kept outputs and dropped links follow the summary", () => {
	const html = render({ entry, record: keepset });
	const t = text(html);
	assert.match(t, /Compacted · 14 entries replaced · 2 outputs kept · 3 dropped · \d\d:\d\d/, "the row says what happened, with no method name or figures");
	assert.match(html, /title="Context compacted \(threshold\) · keepset · 14 entries replaced · 2 outputs kept \(8\.0k of 20\.0k\) · 3 dropped\nplanner magpie\/claude-haiku-5-5 · 1 request · 300 out \/ 9\.6k in · 99% of 9600 prompt tokens read from cache"/, "the title holds the reason, the method, the figures and the planner cost");
	assert.match(html, /data-record="true">Context compacted \(threshold\) · keepset · 14 entries replaced · 2 outputs kept \(8\.0k of 20\.0k\)/, "and so does the body");
	assert.match(html, /data-planner="true">planner magpie\/claude-haiku-5-5/, "and the body's first line");
	assert.match(html, /data-kept="t2"/);
	assert.match(t, /t3 · bash · 8\.1k tokens · cut at 8k tokens · open in history/);
	assert.match(t, /export const a = 1;/);
	const links = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
	assert.deepEqual(links, ["#/h/devbox%23durable/t/c1?e=21", "#/h/devbox%23durable/t/c1?e=25", "#/h/devbox%23durable/t/c1?e=17"]);
	assert.match(t, /… 2 more/);
	const order = ["Goal: rename the parser.", "Tool outputs kept verbatim", "Conversation record", "Dropped tool outputs (3)"].map((s) => t.indexOf(s));
	assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)), `body order: ${order}`);
});

test("compaction row: a rejected plan reads summary only with the reason; an old row without a record keeps the plain line", () => {
	const fallback: CompactRecord = { method: "native-fallback", taskId: "task-9", reason: "manual", at: 1, replacedEntries: 4, firstKept: 9, planRejected: "keep named an unknown entry (t999)", error: "keep named an unknown entry (t999)" };
	assert.match(text(render({ entry: { ...entry, summary: "native summary text" }, record: fallback })), /Compacted \(manual\) · summary only \(plan rejected: keep named an unknown entry \(t999\)\) · /);
	const old = text(render({ entry: { id: "40", kind: "compaction", summary, ts: 1000 } }));
	assert.match(old, /Context compacted · HC summary with Rarebit record · /);
	assert.match(old, /### t2 · read|t2 · read/, "the whole summary renders as markdown");
});

test("compaction row: a summary too large for the window reads short; the arithmetic is in the title and the body; a bridge planner says why it was uncached", () => {
	const fit = "the summary does not fit: summary 10012 + kept tail 272 + prompt 4711 = 14995 tokens, over the 12600-token compaction trigger";
	const tooLarge: CompactRecord = { method: "native-fallback", taskId: "task-9", reason: "manual", at: 1, replacedEntries: 4, firstKept: 9, planRejected: fit, error: fit, planner: keepset.planner };
	const html = render({ entry: { ...entry, summary: "native summary text" }, record: tooLarge });
	assert.match(text(html), /Compacted \(manual\) · summary only \(plan too large for the window\) · /, "a manual compaction says so");
	assert.match(html, /title="Context compacted \(threshold\) · summary only \(plan too large for the window\)\nplanner [^"]*\nthe summary does not fit: summary 10012 [^"]*compaction trigger\nNext: the outputs stay in the history\. Raise the room with \/auto-compact budget &lt;tokens&gt;, or keep no outputs with \/auto-compact method summary\."/, "the arithmetic and the next step are in the title");
	assert.match(html, /<div class="hint">the summary does not fit: summary 10012 \+ kept tail 272/, "and in the body");
	const bridge = { ...keepset, planner: { ...keepset.planner!, model: "claude/claude-haiku-5-5", usage: { input: 51_362, output: 399, cacheRead: 12_039, cacheWrite: 0, cost: 0 }, promptTokens: 63_401, cache: "19% of 63401 prompt tokens read from cache" } };
	const uncached = render({ entry, record: bridge });
	assert.match(text(uncached), /· 3 dropped · low cache · /);
	assert.match(uncached, /planner mostly uncached: read 19% from cache; expected on the claude\/ subscription bridge \(known gap\); the API route reuses the cache/);
});
