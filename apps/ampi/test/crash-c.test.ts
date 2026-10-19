import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { socketPath } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";
import { BIN, SIM, startNode, kill } from "./crash-fixtures.ts";

test("crash: a node killed between deciding to compact and compacting finishes the decision exactly once", async () => {
	const home = tempHome();
	const budget = { AMPI_WORKING_BUDGET: "2500", AMPI_COMPACT_KEEP_RECENT: "200" };
	let { child, client } = await startNode(home, 50000, { ...budget, AMPI_FAULT: "after-budget-decision" });
	const died = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	try {
		// One turn whose answer is the only W crossing; the node dies right after deciding to compact it.
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Draft the plan\n/sim long 10" });
		await died; // the node killed itself right after committing the budget decision
		client.close();
		({ child, client } = await startNode(home, 50000, budget));
		const view = client.sub({ kind: "thread", threadId });
		await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 20_000);
		await new Promise((r) => setTimeout(r, 1500)); // room for a wrongful second compaction
		const history = await client.req("thread.history", { threadId, before: "1000000", limit: 500 });
		assert.equal(history.entries.filter((e: any) => e.kind === "compaction").length, 1, "the pending decision ran once");
		const { records } = await client.req("compact.records", { threadId });
		assert.equal(records.length, 1);
		assert.equal(records[0].reason, "working_budget", "the restarted node finished its own decision, not an owner request");
		client.close();
	} finally {
		await kill(child);
	}
});
