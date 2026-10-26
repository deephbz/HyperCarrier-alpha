import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseThreadKey } from "../src/node/runtime.ts";
import { tempHome } from "./helpers.ts";
import { kill, SIM, startNode } from "./crash-fixtures.ts";

test("crash-f: a run killed 5 times without progress is parked, shown as attention, and /retry runs it once", async () => {
	const home = tempHome();
	// Slow streaming: the model request is still in flight, with no checkpoint, at every kill.
	let { child, client } = await startNode(home, 5);
	try {
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { requestId: "crash-f", cwd: home, model: SIM, place: { workspace: "new", label: "F" }, prompt: "/sim long 3" });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "streaming");
		const { storeId, conversationId } = parseThreadKey(threadId);
		const parked = async () => {
			const health = await client.req("node.health");
			return health.stores
				.find((s: any) => s.id === storeId)
				.tasks.filter((t: any) => t.conversation === conversationId && t.state === "blocked" && t.reason === "restart_limit");
		};
		// Every open counts the cut-off task; the fifth parks it.
		for (let open = 1; open <= 4; open++) {
			client.close();
			await kill(child);
			({ child, client } = await startNode(home, 5));
			assert.deepEqual(await parked(), [], `open ${open} runs the task again`);
		}
		client.close();
		await kill(child);
		({ child, client } = await startNode(home, 5000));
		const blocked = await parked();
		assert.equal(blocked.length, 1, "the fifth open parks the cut-off task");

		const rows = client.sub({ kind: "threads" });
		const row = (await client.until<any>(rows, (v) => v.threads[threadId]?.attention)).threads[threadId];
		assert.equal(row.activity, "idle", "a parked run looks idle");
		assert.match(row.attention[0].reason, /cut off 5 times .*parked; \/retry/, "and the summary says why");

		const retried = await client.req("thread.command", { threadId, name: "retry" });
		assert.equal(retried.evidence, "retried");
		assert.deepEqual(await parked(), [], "the retried task is no longer parked");
		const done = await client.until<any>(rows, (v) => v.threads[threadId]?.activity === "idle" && !v.threads[threadId].attention && /Paragraph/.test(v.threads[threadId].preview ?? ""), 20_000);
		assert.equal(done.threads[threadId].lastError, undefined);
		assert.equal((await client.req("thread.command", { threadId, name: "retry" })).evidence, "nothing_parked", "a second /retry finds nothing");
		client.close();
	} finally {
		await kill(child);
	}
});
