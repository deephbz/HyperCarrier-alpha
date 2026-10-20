import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

test("Auto Compact: crossing W compacts with the HC summary; a summarizer failure falls back and is recorded", async () => {
	process.env.AMPI_WORKING_BUDGET = "2500";
	process.env.AMPI_COMPACT_KEEP_RECENT = "200";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: await hydrate() });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Draft the migration plan for the orders table\n/sim long 4" });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.contextTokens);
		const before = (await client.until<any>(threads, (v) => v.threads[threadId]?.workingBudget)).threads[threadId];
		assert.equal(before.workingBudget, 2500, "W is the configured cap, below 90% of the 64k window");
		await client.req("thread.submit", { threadId, content: "Add the rollback section\n/sim long 4" });
		await client.req("thread.submit", { threadId, content: "Now the verification steps\n/sim long 4" });
		const view = client.sub({ kind: "thread", threadId });
		const compacted = await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 20_000);
		const entry = compacted.entries.find((e: any) => e.kind === "compaction");
		assert.match(entry.summary, /## Working-state summary/);
		assert.match(entry.summary, /## Conversation record/);
		assert.match(entry.summary, /\[USER\]\nDraft the migration plan for the orders table/);
		const { records, workingBudget } = await client.req("compact.records", { threadId });
		assert.equal(workingBudget, 2500);
		const record = records[0];
		assert.equal(record.method, "hc-summary");
		assert.equal(record.reason, "working_budget");
		assert.ok(record.trigger.tokens > 2500, JSON.stringify(record));
		assert.equal(record.conversationRecord.fullHistory, true);

		// A summarizer outage: durable's native summary still compacts, and the record names the fallback and why.
		const second = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Short thread /sim compact-error" });
		await client.until<any>(threads, (v) => v.threads[second.threadId]?.activity === "idle" && v.threads[second.threadId]?.preview);
		await client.req("thread.submit", { threadId: second.threadId, content: "one more" });
		await client.until<any>(threads, (v) => v.threads[second.threadId]?.activity === "idle" && v.threads[second.threadId]?.preview?.includes("one more"));
		await client.req("thread.compact", { threadId: second.threadId });
		const secondView = client.sub({ kind: "thread", threadId: second.threadId });
		const fallback = await client.until<any>(secondView, (v) => v.entries.some((e: any) => e.kind === "compaction"));
		assert.match(fallback.entries.find((e: any) => e.kind === "compaction").summary, /native summary/);
		const failed = (await client.req("compact.records", { threadId: second.threadId })).records[0];
		assert.equal(failed.method, "native-fallback");
		assert.match(failed.error, /Simulated summarizer outage/);
		assert.deepEqual(client.gaps, [], "every replica applied a contiguous ops stream");
		client.close();
	} finally {
		await daemon.stop();
		delete process.env.AMPI_WORKING_BUDGET;
		delete process.env.AMPI_COMPACT_KEEP_RECENT;
	}
});
