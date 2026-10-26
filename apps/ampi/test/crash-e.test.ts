import "./bound.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseThreadKey } from "../src/node/runtime.ts";
import { tempHome } from "./helpers.ts";
import { kill, SIM, startNode } from "./crash-fixtures.ts";

type Entry = { kind: "model" | "tool"; store: string; conversation: string };
const entries = (path: string): Entry[] =>
	existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const finished = (v: any) => v.entries.some((e: any) => e.kind === "assistant" && e.stop === "stop");

test("crash-e: a node killed after two Close intents and before their aborts never runs them again; other work resumes", async () => {
	const home = tempHome();
	const before = join(home, "entries-before.jsonl"), after = join(home, "entries-after.jsonl");
	// The fault stores each Close intent and skips the mark: the state a kill between intent and abort leaves.
	let { child, client } = await startNode(home, 40, { AMPI_FAULT: "close-intent-only", AMPI_ENTRY_LOG: before });
	try {
		const threads = client.sub({ kind: "threads" });
		const streaming = (id: string) => client.until<any>(threads, (v) => v.threads[id]?.activity === "streaming", 20_000);
		const a = await client.req("thread.create", { requestId: "crash-e", cwd: home, model: SIM, place: { workspace: "new", label: "E" }, prompt: "/sim long 200" });
		await streaming(a.threadId);
		const history = await client.req("thread.history", { threadId: a.threadId, before: "1000000", limit: 5 });
		const at = String(history.entries[0].id);
		const b = await client.req("thread.fork", { threadId: a.threadId, entryId: at });
		const c = await client.req("thread.fork", { threadId: a.threadId, entryId: at });
		await client.req("thread.submit", { threadId: b.threadId, content: "/sim long 200" });
		await client.req("thread.submit", { threadId: c.threadId, content: "/sim long 3" });
		await Promise.all([streaming(b.threadId), streaming(c.threadId)]);
		for (const id of [a.threadId, b.threadId]) assert.equal((await client.req("thread.close", { threadId: id })).evidence, "closed");
		await client.until<any>(threads, (v) => v.threads[a.threadId]?.closed && v.threads[b.threadId]?.closed);
		const store = parseThreadKey(a.threadId).storeId;
		const conv = (id: string) => parseThreadKey(id).conversationId;
		const ranBefore = new Set(entries(before).filter((e) => e.store === store && e.kind === "model").map((e) => e.conversation));
		assert.deepEqual([...ranBefore].sort(), [conv(a.threadId), conv(b.threadId), conv(c.threadId)].sort(), "all three runs started");
		client.close();
		await kill(child);

		({ child, client } = await startNode(home, 5000, { AMPI_ENTRY_LOG: after }));
		const reopened = client.sub({ kind: "threads" });
		const view = client.sub({ kind: "thread", threadId: c.threadId });
		await client.until<any>(view, finished, 20_000);
		const list = await client.until<any>(reopened, (v) => [a.threadId, b.threadId].every((id) => v.threads[id]?.closed && v.threads[id].activity === "idle"), 20_000);
		for (const id of [a.threadId, b.threadId]) {
			assert.equal(list.threads[id].live, false);
			const page = await client.req("thread.history", { threadId: id, before: "1000000", limit: 100 });
			assert.equal(page.entries.some((e: any) => e.kind === "assistant" && e.stop === "stop"), false, `${id} never finished its run`);
		}
		const ranAfter = entries(after).filter((e) => e.store === store);
		assert.deepEqual(
			ranAfter.filter((e) => e.conversation !== conv(c.threadId)),
			[],
			"no model request or tool call starts under a closed conversation after reopen",
		);
		assert.ok(ranAfter.some((e) => e.kind === "model" && e.conversation === conv(c.threadId)), "the unrelated run resumed");
		client.close();
	} finally {
		await kill(child);
	}
});
