import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { tempHome } from "./helpers.ts";
import { kill, killWhileStreaming, SIM, startNode } from "./crash-fixtures.ts";

test("Close keeps an ended run's reason in the thread summary, without the /retry hint, also after a restart", async () => {
	const home = tempHome();
	// Slow streaming: the model request is still in flight, with no checkpoint, at every kill (as crash-f).
	let { child, client } = await startNode(home, 5);
	try {
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { requestId: "close-ended", cwd: home, model: SIM, place: { workspace: "new", label: "P" }, prompt: "/sim long 3" });
		// Kills in every model request end the run (pi.live.runFailure, interrupted), as in crash-f.
		({ child, client } = await killWhileStreaming(home, child, client, threadId));
		const rows = client.sub({ kind: "threads" });
		const open = (await client.until<any>(rows, (v) => v.threads[threadId]?.attention)).threads[threadId];
		assert.match(open.attention[0].reason, /^The node stopped while the model was answering, with no retry left; \/retry continues it$/);

		assert.equal((await client.req("thread.close", { threadId })).evidence, "closed");
		const reason = (row: any) => row?.attention?.map((a: any) => a.reason).join("; ") ?? "";
		const closed = (await client.until<any>(rows, (v) => v.threads[threadId]?.closed && !/\/retry/.test(reason(v.threads[threadId])))).threads[threadId];
		assert.match(reason(closed), /^The node stopped while the model was answering, with no retry left$/, "the closed row still says why the run stopped");
		assert.doesNotMatch(reason(closed), /\/retry/, "a closed thread offers no /retry");
		await assert.rejects(client.req("thread.command", { threadId, name: "retry" }), (error: any) => error.code === "closed", "/retry never continues a closed thread");

		client.close();
		await kill(child);
		({ child, client } = await startNode(home, 5000));
		const again = client.sub({ kind: "threads" });
		const reopened = (await client.until<any>(again, (v) => v.threads[threadId]?.closed)).threads[threadId];
		assert.match(reason(reopened), /^The node stopped while the model was answering, with no retry left$/, "the reason survives a restart");
		assert.doesNotMatch(reason(reopened), /\/retry/);
		client.close();
	} finally {
		await kill(child);
	}
});
