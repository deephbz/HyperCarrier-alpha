import "./bound.ts";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { socketPath } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";
import { BIN, SIM, startNode, kill } from "./crash-fixtures.ts";

test("crash: a SIGKILLed node resumes an interrupted run after restart", async () => {
	const home = tempHome();
	let { child, client } = await startNode(home, 2000);
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim bash sleep 3; echo slept\n/sim bash echo second-step" });
		let view = client.sub({ kind: "thread", threadId });
		await client.until<any>(view, (v) => (v.live?.tools ?? []).some((t: any) => t.status === "running"), 10_000);
		await kill(child);
		({ child, client } = await startNode(home, 2000));
		view = client.sub({ kind: "thread", threadId });
		const done = await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "assistant" && e.stop === "stop") && !v.live?.run, 30_000);
		const results = done.entries.filter((e: any) => e.kind === "tool-result");
		// The interrupted call gets a recorded result (bash is not replay-safe, so it is not silently rerun), and the run
		// continues to its next step instead of being lost.
		assert.equal(results.length, 2, JSON.stringify(results.map((r: any) => [r.name, r.isError, r.text.slice(0, 80)])));
		assert.ok(results[0].isError, "the interrupted call is reported as an error, not as success");
		assert.match(results[1].text, /second-step/);
		assert.deepEqual(client.gaps, []);
		client.close();
	} finally {
		await kill(child);
	}
});
