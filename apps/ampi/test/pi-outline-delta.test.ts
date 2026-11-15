import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { test } from "node:test";
import type { ThreadOutline } from "../src/shared/protocol.ts";
import { applyOutline, outlineArgs, replyBase, replyBytes, type OutlineReply } from "./outline-delta.ts";
import { assistant, line, iso, setup, toolResult, user } from "./pi-host-fixtures.ts";

// Defect: a page refetched the whole outline (every prompt, up to 2000) on each new entry, though most entries are not
// prompts (outline-task.md). The Host must answer a page that holds an outline with what changed.
//
// BYTE BOUND: a reply that adds no prompt carries only the new version, the base it builds on, the entry count and
// the truncation flag. Two version strings plus ~80 bytes of JSON keys and numbers fit in 512 bytes with room for a
// longer version format; the bound does not grow with the held outline. The held outline here has 301 prompts of
// 120-character first lines, so today's full reply is ~45 KB, two orders of magnitude over the bound.
const BOUND = 512;
const THREAD = "pi:sess-a";
const PROMPTS = 300;

async function heldSession(t: Parameters<typeof setup>[0]) {
	const { f, browser } = await setup(t);
	const thread = browser.sub("devbox", { kind: "thread", threadId: THREAD });
	let parent = "r1", n = 10;
	const append = (text: string, last: string) => { appendFileSync(f.sessionA, text); parent = last; };
	/** Waits until the thread publishes `id`; returns the published version. */
	const settle = async (id: string) => (await browser.until<any>(thread, (v) => v.entries?.some((e: any) => e.id === id), 10_000)).sourceVersion as string;
	const outline = (held?: ThreadOutline) => browser.req("devbox", "thread.outline", outlineArgs(THREAD, held)) as Promise<OutlineReply>;
	/** N entries that are not prompts: assistant turns and tool results. */
	const nonUser = (count: number) => {
		let text = "", last = parent;
		for (let i = 0; i < count; i++) {
			const id = `x${n}`;
			text += i % 2 ? toolResult(id, last, n, `call-${last}`) : assistant(id, last, n, `reply ${n}`);
			last = id; n++;
		}
		append(text, last);
		return last;
	};
	const prompt = (id: string) => { append(user(id, parent, n++, `${id} ${"prompt words ".repeat(12)}\nsecond line`), id); return id; };
	await settle("r1");
	let lines = "", last = parent;
	for (let i = 0; i < PROMPTS; i++) {
		lines += user(`p${i}`, last, n, `prompt ${i} ${"long first line ".repeat(8)}\nmore`) + assistant(`q${i}`, `p${i}`, n + 1, `answer ${i}`);
		last = `q${i}`; n += 2;
	}
	append(lines, last);
	const version = await settle(last);
	const held = await outline();
	assert.equal(held.version, version, "setup: the outline reads the published version");
	assert.equal(held.users.length, PROMPTS + 1, "setup: every prompt is in the outline");
	assert.ok(replyBytes(held) > 40 * BOUND, `setup: today's full reply is large (${replyBytes(held)} B)`);
	return { f, held, settle, outline, nonUser, prompt, append, at: () => ({ parent, n: n++ }) };
}

/** The page applies a reply as the new outline client would: a base mismatch asks again with nothing held. */
async function applied(s: Awaited<ReturnType<typeof heldSession>>, held: ThreadOutline, reply: OutlineReply) {
	const next = applyOutline(held, reply);
	return next === "refetch" ? applyOutline(undefined, await s.outline()) as ThreadOutline : next;
}

test("outline delta: a page holding the outline pays at most a fixed byte bound per reply while non-prompt entries arrive", async (t) => {
	const s = await heldSession(t);
	let held = s.held;
	for (const count of [1, 7, 40]) {
		const version = await s.settle(s.nonUser(count));
		const reply = await s.outline(held);
		assert.equal(reply.version, version, `${count} entries: the reply reads the published version`);
		const next = await applied(s, held, reply);
		assert.deepEqual(next, await s.outline(), `${count} entries: the page's outline equals the full outline`);
		assert.ok(replyBytes(reply) <= BOUND, `${count} non-prompt entries: the reply is ${replyBytes(reply)} B, over the ${BOUND} B bound (the page held ${held.users.length} prompts; base ${String(replyBase(reply))})`);
		held = next;
	}
});

test("outline delta: a new prompt adds exactly that prompt to the held outline", async (t) => {
	const s = await heldSession(t);
	const id = s.prompt("fresh");
	const version = await s.settle(s.nonUser(5));
	const reply = await s.outline(s.held);
	assert.equal(reply.version, version);
	const next = await applied(s, s.held, reply);
	const full = await s.outline();
	assert.deepEqual(next, full, "the page's outline equals the full outline");
	assert.deepEqual(next.users.map((u) => u.id), [...s.held.users.map((u) => u.id), id], "exactly the new prompt is added");
	const added = full.users.at(-1)!;
	assert.ok(replyBytes(reply) <= BOUND + replyBytes(added), `the reply is ${replyBytes(reply)} B; one prompt allows ${BOUND + replyBytes(added)} B`);
});

test("outline delta: a compaction is a zero-prompt delta", async (t) => {
	const s = await heldSession(t);
	const { parent, n } = s.at();
	s.append(line({ type: "compaction", id: "k1", parentId: parent, timestamp: iso(n), summary: "Earlier work", firstKeptEntryId: `p${PROMPTS / 2}`, tokensBefore: 1000 }), "k1");
	await s.settle("k1");
	const reply = await s.outline(s.held);
	const next = await applied(s, s.held, reply);
	assert.deepEqual(next, await s.outline(), "after a compaction the page holds the full outline");
	assert.ok(replyBytes(reply) <= BOUND, `a compaction moves no prompt: the reply is ${replyBytes(reply)} B, over the ${BOUND} B bound`);
	assert.equal(replyBase(reply), s.held.version, "the reply is a delta on the held version");
});

test("outline delta: a branch change and a derivation bump return the full outline", async (t) => {
	const s = await heldSession(t);
	// A reader reset: a new prompt on an early entry leaves every later prompt off the current branch.
	const at = s.at();
	s.append(user("b1", "a1", at.n, "a different direction"), "b1");
	await s.settle("b1");
	const reset = await s.outline(s.held);
	const full = await s.outline();
	assert.equal(replyBase(reset), undefined, "a branch change answers with the full outline");
	assert.deepEqual(applyOutline(s.held, reset), full, "the page holds the full outline after a branch change");
	assert.deepEqual(full.users.map((u) => u.id), ["u1", "b1"], "the branch holds only its own prompts");
	// An outline held from another derivation (an upgraded Host): the version prefix names the derivation.
	const old = { ...full, version: "0-old-derivation:" + full.version.split(":").slice(1).join(":") };
	const bumped = await s.outline(old);
	assert.equal(replyBase(bumped), undefined, "a derivation bump answers with the full outline");
	assert.deepEqual(applyOutline(old, bumped), full);
});

test("outline delta: a request without held state gets today's full outline (an old page)", async (t) => {
	const s = await heldSession(t);
	await s.settle(s.nonUser(3));
	const reply = await s.outline();
	assert.equal(replyBase(reply), undefined, "a full outline carries no base");
	assert.equal(reply.users.length, PROMPTS + 1, "every prompt on the branch");
	assert.equal(reply.users[0]!.id, "u1");
	assert.equal(reply.totalEntries, s.held.totalEntries + 3);
	assert.equal(reply.truncated, false);
});

test("outline delta: past 2000 prompts, a new prompt that shifts the window is a one-prompt delta", async (t) => {
	const s = await heldSession(t);
	// Past the outline's 2000-prompt window: the oldest held prompts fall out as new ones arrive.
	let text = "", { parent, n } = s.at(), last = parent;
	for (let i = 0; i < 1800; i++) { text += user(`w${i}`, last, n++, `window ${i} ${"long first line ".repeat(7)}`); last = `w${i}`; }
	s.append(text, last);
	await s.settle(last);
	const held = await s.outline();
	assert.equal(held.truncated, true, "setup: the outline is truncated");
	assert.equal(held.users.length, 2000);
	await s.settle(s.prompt("shift"));
	const reply = await s.outline(held);
	const next = await applied(s, held, reply);
	const full = await s.outline();
	assert.deepEqual(next, full, "after the window shifts the page holds the full outline");
	assert.equal(full.users.at(-1)!.id, "shift");
	const allowed = BOUND + replyBytes(full.users.at(-1));
	assert.ok(replyBytes(reply) <= allowed, `the reply is ${replyBytes(reply)} B; one prompt allows ${allowed} B`);
});
