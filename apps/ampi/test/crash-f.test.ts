import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { tempHome } from "./helpers.ts";
import { kill, killWhileStreaming, SIM, startNode } from "./crash-fixtures.ts";

test("crash-f: a run killed in every model request ends, shows attention, and /retry continues it once", async () => {
	const home = tempHome();
	// Slow streaming: the model request is still in flight, with no checkpoint, at every kill.
	let { child, client } = await startNode(home, 5);
	try {
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { requestId: "crash-f", cwd: home, model: SIM, place: { workspace: "new", label: "F" }, prompt: "/sim long 3" });
		// A request in flight at a crash is a failed attempt: retry.maxRetries 3, so the fourth kill ends the run.
		let kills: number;
		({ child, client, kills } = await killWhileStreaming(home, child, client, threadId));
		assert.equal(kills, 4, "every attempt of retry.maxRetries 3 was cut off");
		const rows = client.sub({ kind: "threads" });
		const row = (await client.until<any>(rows, (v) => v.threads[threadId]?.attention)).threads[threadId];
		assert.equal(row.activity, "idle", "the ended run looks idle");
		assert.match(row.attention[0].reason, /^The node stopped while the model was answering, with no retry left; \/retry continues it$/, "and the summary says why");
		assert.equal(row.lastError, undefined, "the reason shows once, as attention");

		const retried = await client.req("thread.command", { threadId, name: "retry" });
		assert.equal(retried.evidence, "continued");
		const done = await client.until<any>(rows, (v) => v.threads[threadId]?.activity === "idle" && !v.threads[threadId].attention && /Paragraph/.test(v.threads[threadId].preview ?? ""), 20_000);
		assert.equal(done.threads[threadId].lastError, undefined);
		assert.equal((await client.req("thread.command", { threadId, name: "retry" })).evidence, "nothing_to_continue", "a second /retry finds nothing");
		client.close();
	} finally {
		await kill(child);
	}
});
