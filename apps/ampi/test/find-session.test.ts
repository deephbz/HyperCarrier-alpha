import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { findCollector, type FindAsk, type SearchResult } from "../src/pi/search.ts";
import type { FindReply } from "../src/shared/protocol.ts";
import { FindSession } from "../web/src/components/find-session.ts";

// Find keeps the reader's place among the hub's windows (FindSession over findCollector). The observer incidents: a
// step past an edge sent one request per keypress, an old hub was asked for windows it cannot give, an unplaced result
// threw the reader to the oldest match, and a backward wrap guessed the branch's end from the client's window.

/** A branch of `count` prose matches e0…e{count-1}; e0 is a prompt. `indexed` false: the Host has not indexed it yet. */
function hub(count: number, options: { windows?: boolean; known?: (id: string) => boolean; indexed?: () => boolean } = {}) {
	const asks: FindAsk[] = [];
	const find = (query: string, ask: FindAsk) => { const reply = answer(query, ask); inflight.push(reply); return reply; };
	const answer = async (_query: string, ask: FindAsk): Promise<FindReply> => {
		asks.push(ask);
		if (options.indexed && !options.indexed()) { await new Promise((resolve) => setTimeout(resolve, 1)); return { indexing: true }; }
		if (options.known && ask.from && !options.known(ask.from)) ask = { ...ask, from: `gone:${ask.from}` };
		const found = findCollector(ask);
		for (let i = 0; i < count; i++) {
			const id = `e${i}`;
			found.visit({ id, kind: i ? "assistant" : "human" }, { entry: id, ref: "", threadId: "s", snippet: id, version: "v", prose: true });
		}
		const value = found.close();
		await new Promise((resolve) => setTimeout(resolve, 1));
		if (options.windows === false) { const { windows: _w, anchored: _a, ...old } = value; return { ...old, hits: value.hits.slice(0, 200), scope: "", asOf: 0 }; }
		return { ...value, scope: "", asOf: 0 };
	};
	return { asks, find };
}
const inflight: Promise<unknown>[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Waits for the settle timer and every request, including those a reply starts. */
async function flush() {
	do { await tick(); while (inflight.length) await inflight.shift(); await tick(); } while (inflight.length);
}

async function session(h: ReturnType<typeof hub>, reading?: string) {
	const revealed: string[] = [];
	const find = new FindSession({ find: h.find, reading: () => reading, reveal: (hit) => revealed.push(hit.entry), settleMs: 0 });
	find.show();
	find.setQuery("e");
	await flush();
	const n = () => { const v = find.get(); return v.at === undefined ? undefined : v.skipped + v.at + 1; };
	return { find, revealed, n, view: () => find.get() };
}

test("find session: a result opens at the reader's entry, and a step past the window's edge asks once and stays contiguous", async () => {
	const h = hub(600);
	const { find, revealed, n } = await session(h, "e450");
	assert.deepEqual(h.asks, [{ from: "e450" }]);
	assert.equal(n(), 451);
	assert.deepEqual(revealed, ["e450"]);
	// The window holds e350–e549; 99 steps reach e549, the next asks for the window after it.
	for (let i = 0; i < 99; i++) find.step(1);
	assert.equal(n(), 550);
	for (let i = 0; i < 20; i++) find.step(1);
	assert.deepEqual(h.asks.slice(1), [{ from: "e549" }], "20 quick steps past the edge send one request");
	await flush();
	assert.equal(n(), 551);
	assert.equal(find.get().wrapped, undefined);
});

test("find session: a backward wrap asks the hub for the tail and lands on the last match", async () => {
	const h = hub(600);
	const { find, n, view } = await session(h);
	assert.deepEqual(h.asks, [{}], "a hidden reader place asks for the head");
	assert.equal(n(), 1);
	find.step(-1);
	await flush();
	assert.deepEqual(h.asks.at(-1), { tail: true });
	assert.equal(n(), 600);
	assert.equal(view().wrapped, "bottom");
	// The next step clears the hint; a forward wrap from the tail asks for the head.
	find.step(-1);
	assert.equal(view().wrapped, undefined);
	find.step(1); find.step(1);
	await flush();
	assert.deepEqual(h.asks.at(-1), {});
	assert.equal(n(), 1);
	assert.equal(view().wrapped, "top");
});

test("find session: an unplaced result keeps the reader still; the next step asks once more, then moves", async () => {
	// The hub's copy lacks the reader's entry: a live entry newer than the copy.
	const h = hub(300, { known: () => false });
	const { find, revealed, view } = await session(h, "e299");
	assert.equal(view().at, undefined);
	assert.deepEqual(revealed, [], "Find does not move the reader");
	assert.equal(view().total, 300);
	find.step(1);
	await flush();
	assert.deepEqual(h.asks, [{ from: "e299" }, { from: "e299" }], "one retry with the reader's entry");
	assert.equal(view().at, 0, "still unplaced: forward goes to the first match");
	assert.deepEqual(revealed, ["e0"]);
	// Backward from an unplaced result goes to the tail.
	const back = await session(hub(300, { known: () => false }), "e299");
	back.find.step(-1); await flush();
	assert.equal(back.n(), 300);
	assert.equal(back.view().wrapped, undefined, "a first landing is not a wrap");
	// A retry the copy now places opens at the reader's entry.
	let caught = false;
	const late = await session(hub(300, { known: () => caught }), "e120");
	caught = true;
	late.find.step(1); await flush();
	assert.equal(late.n(), 121);
});

test("find session: an old hub without windows is never asked again; steps wrap within its 200 matches", async () => {
	const h = hub(250, { windows: false });
	const { find, revealed, n, view } = await session(h, "e100");
	assert.equal(view().at, undefined, "an old hub cannot place the reader");
	assert.deepEqual(revealed, []);
	assert.equal(view().total, 250);
	find.step(1);
	assert.equal(n(), 1);
	for (let i = 0; i < 199; i++) find.step(1);
	assert.equal(n(), 200);
	find.step(1);
	assert.equal(n(), 1);
	assert.equal(view().wrapped, "top");
	find.step(-1);
	assert.equal(n(), 200);
	assert.equal(view().wrapped, "bottom");
	assert.equal(h.asks.length, 1);
});

test("find session: before the Host indexes the Session, Find says Indexing and asks again once at each announcement", async () => {
	let indexed = false;
	const h = hub(600, { indexed: () => indexed });
	const { find, revealed, n, view } = await session(h, "e450");
	assert.deepEqual([view().indexing, view().busy, view().error], [true, false, undefined], "Indexing is not a failure");
	find.step(1);
	await flush();
	assert.equal(h.asks.length, 1, "no timer and no step asks while the request waits");
	// An announcement the Host still answers with Indexing leaves the request waiting for the next one.
	find.indexed();
	await flush();
	assert.equal(h.asks.length, 2);
	assert.equal(view().indexing, true);
	indexed = true;
	find.indexed();
	await flush();
	assert.deepEqual(h.asks, [{ from: "e450" }, { from: "e450" }, { from: "e450" }], "the same request, without an edit");
	assert.deepEqual([view().indexing, n()], [false, 451]);
	assert.deepEqual(revealed, ["e450"]);
	find.indexed();
	await flush();
	assert.equal(h.asks.length, 3, "an announcement asks only for a waiting request");
	// A step past the window's edge after a hub restart waits the same way.
	indexed = false;
	for (let i = 0; i < 100; i++) find.step(1);
	await flush();
	assert.deepEqual([view().indexing, n()], [true, 550]);
	indexed = true;
	find.indexed();
	await flush();
	assert.deepEqual([view().indexing, n()], [false, 551]);
	// A new query or close ends the wait.
	const late = await session(hub(600, { indexed: () => false }), "e1");
	late.find.close();
	late.find.indexed();
	await flush();
	assert.equal(late.view().indexing, false);
});

test("find session: a new query supersedes a request in flight; close forgets the result", async () => {
	const h = hub(600);
	const { find, view } = await session(h, "e0");
	find.step(-1);
	assert.deepEqual(h.asks.at(-1), { tail: true });
	find.setQuery("e1");
	await flush();
	assert.equal(view().at, 0);
	assert.equal(view().wrapped, undefined, "the superseded wrap left no hint");
	// A reveal from elsewhere ends Filter; with Filter already off it does not reveal again (a reveal loop).
	const before = view();
	find.setFilter(false);
	assert.equal(view(), before);
	find.close();
	assert.equal(view().matches.length, 0);
	assert.equal(view().open, false);
});
