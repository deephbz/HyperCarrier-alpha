import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseThreadKey } from "../src/node/runtime.ts";
import { tempHome } from "./helpers.ts";
import { kill, SIM, startNode } from "./crash-fixtures.ts";

test("Close keeps a parked run's reason in the thread summary, without the /retry hint, also after a restart", async () => {
	const home = tempHome();
	// Slow streaming: the model request is still in flight, with no checkpoint, at every kill (as crash-f).
	let { child, client } = await startNode(home, 5);
	try {
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { requestId: "close-parked", cwd: home, model: SIM, place: { workspace: "new", label: "P" }, prompt: "/sim long 3" });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "streaming");
		const { storeId, conversationId } = parseThreadKey(threadId);
		// The fifth open after a kill parks the cut-off task.
		for (let open = 1; open <= 5; open++) {
			client.close();
			await kill(child);
			({ child, client } = await startNode(home, open === 5 ? 5000 : 5));
		}
		const health = await client.req("node.health");
		const blocked = health.stores.find((s: any) => s.id === storeId).tasks.filter((t: any) => t.conversation === conversationId && t.state === "blocked");
		assert.equal(blocked.length, 1, "the task is parked");
		const rows = client.sub({ kind: "threads" });
		const open = (await client.until<any>(rows, (v) => v.threads[threadId]?.attention)).threads[threadId];
		assert.match(open.attention[0].reason, /cut off 5 times .*parked; \/retry/);

		assert.equal((await client.req("thread.close", { threadId })).evidence, "closed");
		const reason = (row: any) => row?.attention?.map((a: any) => a.reason).join("; ") ?? "";
		const closed = (await client.until<any>(rows, (v) => v.threads[threadId]?.closed && !/\/retry/.test(reason(v.threads[threadId])))).threads[threadId];
		assert.match(reason(closed), /cut off 5 times .*parked/, "the closed row still says why the run stopped");
		assert.doesNotMatch(reason(closed), /\/retry/, "a closed thread offers no /retry");

		client.close();
		await kill(child);
		({ child, client } = await startNode(home, 5000));
		const again = client.sub({ kind: "threads" });
		const reopened = (await client.until<any>(again, (v) => v.threads[threadId]?.closed)).threads[threadId];
		assert.match(reason(reopened), /cut off 5 times .*parked/, "the reason survives a restart");
		assert.doesNotMatch(reason(reopened), /\/retry/);
		client.close();
	} finally {
		await kill(child);
	}
});
