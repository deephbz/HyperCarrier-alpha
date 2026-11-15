import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { loadBudget, PAGE_LOAD_MS } from "./page-load.ts";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import type { ThreadOutline } from "../src/shared/protocol.ts";
import { heldOf, hostReply, replyBytes, type OutlineReply } from "./outline-delta.ts";

// The page half of the outline delta (outline-task.md): the real ThreadView and its outline hook against a fixture
// Host. The fixture answers as a delta Host (helper `hostReply`) or as an old Host (always the full outline), and it
// counts every thread.outline request, the requests in flight and the reply bytes.
// BYTE BOUND: as in pi-outline-delta.test.ts, a reply that adds no prompt fits in 512 B. The held outline has 300
// prompts with 120-character first lines, so one full reply is ~40 KB.
const BOUND = 512;
const web = fileURLToPath(new URL("../web", import.meta.url));
const THREAD = "pi:s1";

async function componentScript(): Promise<string> {
	const entry = join(web, "outline-delta-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "outline-delta-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { ThreadView } from ${JSON.stringify(join(web, "src/components/ThreadView.tsx"))};
				const summary = { id: ${JSON.stringify(THREAD)}, title: 'Outline delta', createdAt: 0, updatedAt: 0, kind: 'thread', activity: 'idle', queued: 0, costUsd: 0 };
				createRoot(document.getElementById('root')).render(React.createElement('div', { className: 'main-slot', style: { height: '600px' } },
					React.createElement(ThreadView, { host: 'devbox', threadId: ${JSON.stringify(THREAD)}, summary, models: [], panel: undefined, setPanel() {} })));
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "OutlineDeltaTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}

/** A Session model: prompts at known ordinals among `total` entries; each change is a new version. */
class Session {
	k = 0; total = 0; users: ThreadOutline["users"] = []; tag = "e";
	constructor(prompts: number) { for (let i = 0; i < prompts; i++) { this.prompt(); this.nonUser(); } this.k = 0; }
	get version() { return "v" + this.k; }
	prompt() { this.users.push({ id: "e" + this.total, ordinal: this.total, firstLine: `Question ${this.total} ${"long first line ".repeat(7)}` }); this.total++; this.k++; }
	nonUser() { this.total++; this.k++; }
	/** A branch replaced: other entries under other ids, so the new frame does not hold the old frame's newest entry. */
	branch(keep: number) {
		this.tag = "b";
		this.users = this.users.slice(0, keep).map((u) => ({ ...u, id: "b" + u.ordinal }));
		this.total = this.users.at(-1)!.ordinal + 2; this.k++;
	}
	outline(): ThreadOutline { return { version: this.version, totalEntries: this.total, truncated: false, users: this.users.map((u) => ({ ...u })) }; }
	view() {
		const users = new Map(this.users.map((u) => [u.ordinal, u]));
		const entries = [];
		for (let o = Math.max(0, this.total - 40); o < this.total; o++) {
			const u = users.get(o);
			entries.push(u ? { id: u.id, kind: "user", text: u.firstLine, images: 0 } : { id: this.tag + o, kind: "assistant", blocks: [{ type: "text", text: "Answer " + o }] });
		}
		return { conversationId: "s1", sourceVersion: this.version, hiddenBefore: true, entries, live: {}, inbox: {}, agent: { cwd: "/work" }, usage: { costUsd: 0 } };
	}
}

type Host = "delta" | "old";
type Hold = (args: Record<string, unknown>, reply: () => void) => boolean;

let bundle: Promise<string> | undefined;
let chrome: ReturnType<typeof chromium.launch> | undefined;
after(async () => { await (await chrome)?.close(); });

async function open(t: { after: (fn: () => unknown) => void }, host: Host, session: Session) {
	const script = await (bundle ??= componentScript());
	const browser = await (chrome ??= chromium.launch({ headless: true, executablePath: findChrome() }));
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
	t.after(() => page.context().close());
	page.setDefaultTimeout(5000); loadBudget(page);
	await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<style>" + readFileSync(join(web, "src/styles.css"), "utf8") + "</style><div id=\"root\"></div><script>" + script + "</script>" }));
	const stats = { connections: 0, threadSubs: 0, requests: 0, inFlight: 0, maxInFlight: 0, bytes: [] as number[], held: [] as unknown[] };
	let publish!: () => void, drop!: () => void;
	let hold: Hold | undefined;
	let override: ((reply: OutlineReply) => OutlineReply) | undefined;
	await page.routeWebSocket("**/ws", (client) => {
		const send = (frame: unknown) => client.send(JSON.stringify(frame));
		let sid: number | undefined;
		stats.inFlight = 0; stats.connections++; // A dropped connection loses its requests.
		publish = () => { if (sid !== undefined) send({ t: "snap", sid, value: session.view() }); };
		drop = () => void client.close();
		send({ t: "hosts", hosts: [{ id: "devbox", link: "devbox", label: "Demo", kind: "pi-local", status: "connected" }] });
		client.onMessage((message) => {
			const f = JSON.parse(String(message));
			if (f.t === "sub" && f.topic.kind === "thread") { stats.threadSubs++; sid = f.sid; send({ t: "snap", sid, value: session.view() }); }
			else if (f.t === "sub") send({ t: "snap", sid: f.sid, value: f.topic.kind === "threads" ? { threads: {} } : {} });
			else if (f.t === "req" && f.op === "thread.outline") {
				stats.requests++; stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
				stats.held.push(heldOf(f.args ?? {}) ?? null);
				// The reply is computed when sent, from the Session as it is then: a held request answers a moved Session.
				const reply = () => {
					const full = session.outline();
					let value: OutlineReply = host === "old" ? full : hostReply(full, f.args ?? {});
					if (override) { value = override(value); override = undefined; }
					stats.inFlight--; stats.bytes.push(replyBytes(value));
					send({ t: "res", id: f.id, ok: true, value });
				};
				if (!hold?.(f.args ?? {}, reply)) reply();
			} else if (f.t === "req" && f.op === "thread.history") send({ t: "res", id: f.id, ok: true, value: { entries: session.view().entries, more: false, version: session.version } });
			else if (f.t === "req" || f.t === "hub") send({ t: "res", id: f.id, ok: false, error: { code: "unsupported", message: "fixture" } });
		});
	});
	await page.goto("http://localhost/");
	await shows(page, session);
	return {
		page, stats, publish: () => publish(), drop: () => drop(),
		holdNext: (h: Hold) => { hold = h; },
		release: () => { hold = undefined; },
		overrideNext: (o: (reply: OutlineReply) => OutlineReply) => { override = o; },
	};
}

/** The page shows the Session's current outline: its version, one mark per prompt, the last prompt's title. */
async function shows(page: Page, session: Session, what = "") {
	const expected = session.outline();
	await page.locator(`[data-outline-version="${expected.version}"]`).waitFor({ timeout: PAGE_LOAD_MS });
	await page.waitForFunction(() => document.querySelector(".companion-scrollbar")?.getAttribute("aria-busy") !== "true");
	const ids = await page.locator("[data-user-mark]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.userMark));
	assert.deepEqual(ids, expected.users.map((u) => u.id), `${what}: the page's prompt marks equal the full outline at ${expected.version}`);
	const last = expected.users.at(-1)!;
	assert.equal(await page.locator(`[data-user-mark="${last.id}"]`).getAttribute("title"), last.firstLine, `${what}: the last mark's title`);
}

const frame = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test("outline delta page: a steady stream of non-prompt entries costs at most the byte bound per reply, one request in flight and one per version", async (t) => {
	const session = new Session(300);
	const p = await open(t, "delta", session);
	const first = p.stats.requests;
	assert.ok(p.stats.bytes[0]! > 40 * BOUND, `setup: the first reply is the full outline (${p.stats.bytes[0]} B)`);
	const VERSIONS = 12;
	for (let i = 0; i < VERSIONS; i++) {
		session.nonUser(); p.publish();
		if (i % 3 === 2) await frame(p.page); // Mostly back to back, as a streaming turn publishes.
	}
	await shows(p.page, session, "after the stream");
	const later = p.stats.bytes.slice(first);
	assert.ok(later.length > 0, "the page asked for the moved outline");
	assert.ok(later.every((b) => b <= BOUND), `each reply after the first fits ${BOUND} B; the replies were ${JSON.stringify(later)} B (held state sent: ${JSON.stringify(p.stats.held.slice(first, first + 2))})`);
	assert.ok(p.stats.maxInFlight <= 1, `at most one outline request in flight; saw ${p.stats.maxInFlight}`);
	assert.ok(p.stats.requests - first <= VERSIONS, `at most one request per new version: ${p.stats.requests - first} requests for ${VERSIONS} versions`);
});

test("outline delta page: a new prompt in the stream adds exactly that prompt", async (t) => {
	const session = new Session(300);
	const p = await open(t, "delta", session);
	const first = p.stats.requests;
	session.nonUser(); session.prompt(); session.nonUser(); p.publish();
	await shows(p.page, session, "after one prompt");
	const added = replyBytes(session.users.at(-1));
	const later = p.stats.bytes.slice(first);
	assert.ok(later.every((b) => b <= BOUND + added), `each reply fits ${BOUND + added} B; the replies were ${JSON.stringify(later)} B`);
});

test("outline delta page: an old Host's reply without a base is applied as the full outline", async (t) => {
	const session = new Session(300);
	const p = await open(t, "old", session);
	session.nonUser(); session.prompt(); p.publish();
	await shows(p.page, session, "old Host, one prompt");
	// The old Host's branch change: the outline shrinks, and the full reply replaces it.
	session.users = session.users.slice(0, 250); session.nonUser(); p.publish();
	await shows(p.page, session, "old Host, branch change");
});

test("outline delta page: a delta on a base the page does not hold is discarded, and the page asks once without held state", async (t) => {
	const session = new Session(300);
	const p = await open(t, "delta", session);
	const first = p.stats.requests;
	p.overrideNext((reply) => ({ ...reply, users: [], base: "v-not-held" }));
	session.nonUser(); p.publish();
	await waitFor(() => p.stats.requests > first, "the page asks for the moved outline");
	assert.ok(p.stats.held[first], "the request for a moved version carries the held state");
	await shows(p.page, session, "after a reply on a base the page does not hold");
	assert.equal(p.stats.requests - first, 2, "one refused delta costs exactly one more request");
	assert.equal(p.stats.held[first + 1], null, "the request after a refused delta carries no held state");
	await frame(p.page);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(p.stats.requests - first, 2, "a refused delta does not loop");
});

test("outline delta page: a reconnect re-asks once on the next connected signal", async (t) => {
	const session = new Session(300);
	const p = await open(t, "delta", session);
	// The request for the next version is in flight when the connection drops; its reply never arrives.
	let lost = false;
	p.holdNext(() => { lost = true; return true; });
	session.nonUser(); p.publish();
	await waitFor(() => lost, "the page asks for the moved outline");
	p.release();
	const before = p.stats.requests;
	p.drop();
	// The hub client reconnects on its own; the thread snapshot at the same version arrives again.
	const subs = p.stats.threadSubs;
	await waitFor(() => p.stats.connections === 2 && p.stats.threadSubs > subs, "the hub client reconnects and resubscribes");
	const asked = await settles(() => p.stats.requests > before, 2000);
	assert.ok(asked, `the reconnect re-asks for the outline it lost: ${p.stats.requests - before} requests in 2 s after the reconnect`);
	await shows(p.page, session, "after the reconnect");
	assert.equal(p.stats.requests - before, 1, "the reconnect re-asks exactly once");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(p.stats.requests - before, 1, "and only once");
});

test("outline delta page: a branch replaced while a request is in flight, whose reply carries the new version, leaves the strip usable with no further request", async (t) => {
	const session = new Session(300);
	const p = await open(t, "delta", session);
	const first = p.stats.requests;
	// Request R for a continuing version is held; the branch is then replaced before R's reply leaves the Host.
	let held: (() => void) | undefined;
	p.holdNext((_args, reply) => { held = reply; return true; });
	session.nonUser(); p.publish();
	await waitFor(() => held !== undefined, "the page asks for the continuing version");
	p.release();
	session.branch(250); p.publish();
	await waitFor(() => p.stats.threadSubs > 0, "setup: the thread is subscribed");
	await frame(p.page); await frame(p.page);
	// R's reply is computed now, from the replaced branch: it carries the view's newest version.
	held!();
	const version = session.version;
	assert.ok(await settles(async () => await p.page.locator(`[data-outline-version="${version}"]`).count() === 1, 3000), `the reply at ${version} lands in the strip`);
	const busy = () => p.page.locator(".companion-scrollbar").getAttribute("aria-busy");
	assert.ok(await settles(async () => await busy() !== "true", 2000), `the strip is not busy 2 s after a reply at the view's version (aria-busy=${await busy()}; ${p.stats.requests - first} requests)`);
	const marks = await p.page.locator("[data-user-mark]").count(), linked = await p.page.locator("[data-user-mark][href]").count();
	assert.equal(marks, 250, "the strip shows the replaced branch's prompts");
	assert.equal(linked, marks, "every dash links");
	const asked = p.stats.requests;
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(p.stats.requests, asked, "no further request is needed");
	assert.equal(asked - first, 1, "the reply at the view's version is the only request after the stream");
});

async function settles(check: () => boolean | Promise<boolean>, ms: number) {
	const end = Date.now() + ms;
	while (!(await check())) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 10)); }
	return true;
}

async function waitFor(check: () => boolean, what: string, ms = 5000) {
	const end = Date.now() + ms;
	while (!check()) { if (Date.now() > end) throw new Error("timed out: " + what); await new Promise((r) => setTimeout(r, 10)); }
}
