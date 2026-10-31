import "./bound.ts";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { socketPath } from "../src/node/daemon.ts";
import { TestClient, tempHome, writePiSettings } from "./helpers.ts";
import { BIN, SIM, startNode, kill } from "./crash-fixtures.ts";

test("crash: a node killed after admitting its compaction does not compact again", async () => {
	const home = tempHome();
	writePiSettings({ auto_compact: { budget_tokens: 2500 }, compaction: { keepRecentTokens: 200 } });
	let { child, client } = await startNode(home, 50000, { AMPI_FAULT: "after-compact-admitted" });
	const died = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	try {
		// One turn whose answer is the only W crossing; the node dies after the compaction task is admitted.
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Draft the plan\n/sim long 10" });
		await died; // the node killed itself right after compact() admitted the task
		client.close();
		({ child, client } = await startNode(home, 50000));
		const view = client.sub({ kind: "thread", threadId });
		await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 20_000);
		await new Promise((r) => setTimeout(r, 1500)); // room for a wrongful second compaction
		const history = await client.req("thread.history", { threadId, before: "1000000", limit: 500 });
		assert.equal(history.entries.filter((e: any) => e.kind === "compaction").length, 1, "the pending decision ran once");
		const { records } = await client.req("compact.records", { threadId });
		assert.equal(records.length, 1, "one compaction record");
		// The HC trigger guard reads live tasks, so it holds nothing after the restarted task finished: a new crossing compacts.
		await client.req("thread.submit", { threadId, content: "Next part\n/sim long 10" });
		const deadline = Date.now() + 20_000;
		while ((await client.req("compact.records", { threadId })).records.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		assert.equal((await client.req("compact.records", { threadId })).records.length, 2, "after crash and restart, the next crossing compacts again");
		client.close();
	} finally {
		await kill(child);
	}
});
