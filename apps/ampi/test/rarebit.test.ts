import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

test("Rarebit: settled Summaries, freshness, eligibility, title, compaction boundary, and recall", async () => {
	process.env.AMPI_RAREBIT_MIN_TOKENS = "0";
	process.env.AMPI_RAREBIT_MAX_RATIO = "1";
	process.env.AMPI_COMPACT_KEEP_RECENT = "1";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate() });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Add a health endpoint to the billing service" });
		const rarebit = client.sub({ kind: "rarebit", threadId });

		// 1. A settled stop is summarized (agent_settled) and the title is proposed from the first user message.
		let index = await client.until<any>(threads, (v) => v.threads[threadId]?.rarebit?.status === "finished");
		assert.equal(index.threads[threadId].rarebit.fresh, true);
		index = await client.until<any>(threads, (v) => v.threads[threadId]?.title === "Add a health endpoint to the billing");
		let view = await client.until<any>(rarebit, (v) => v.state.summary && v.fresh);
		assert.equal(view.state.summary.boundary, "agent_settled");
		assert.deepEqual(
			view.items.map((i: any) => `${i.role}/${i.outcome}`),
			["user/user", "assistant/stop"],
		);

		// 2. A run that ends asking the owner flips the appearance to needs_attention (with reason), separately from
		// activity, which is idle (P5).
		await client.req("thread.submit", { threadId, content: "Pick the storage engine for me /sim attention" });
		index = await client.until<any>(threads, (v) => v.threads[threadId]?.rarebit?.status === "needs_attention" && v.threads[threadId].rarebit.fresh);
		assert.equal(index.threads[threadId].rarebit.reason, "input");
		assert.equal(index.threads[threadId].activity, "idle");

		// 3. Under the default policy a short session is ineligible: the receipt says why, the last Summary stays, and it
		// is no longer fresh because newer evidence exists.
		process.env.AMPI_RAREBIT_MIN_TOKENS = "80000";
		await client.req("thread.submit", { threadId, content: "Also add a readiness probe" });
		view = await client.until<any>(rarebit, (v) => v.state.attempt?.status === "ineligible" && v.count === 6);
		assert.deepEqual(view.state.attempt.reasons, ["total_length_below_minimum"]);
		assert.equal(view.state.summary.sessionStatus, "needs_attention");
		assert.equal(view.fresh, false);
		index = await client.until<any>(threads, (v) => v.threads[threadId]?.rarebit?.fresh === false);

		// 4. A manual Summary skips the eligibility gate and covers the latest evidence again.
		await client.req("rarebit.summarize", { threadId });
		view = await client.until<any>(rarebit, (v) => v.fresh && v.state.summary.boundary === "manual");
		assert.equal(view.state.summary.sessionStatus, "finished");

		// 5. After compaction the earlier evidence leaves model context, Rarebit still shows it, and the agent can
		// recall the exact first request.
		await client.req("thread.compact", { threadId });
		view = await client.until<any>(rarebit, (v) => v.items.some((i: any) => i.kind === "compaction"));
		const first = view.items[0];
		assert.equal(first.text, "Add a health endpoint to the billing service");
		assert.equal(first.outOfContext, true);
		await client.req("thread.submit", { threadId, content: '/sim tool rarebit_recall {"query":"health endpoint","role":"user"}' });
		const thread = client.sub({ kind: "thread", threadId });
		const done = await client.until<any>(thread, (v) => v.entries.some((e: any) => e.kind === "tool-result" && e.name === "rarebit_recall"));
		const recall = done.entries.find((e: any) => e.kind === "tool-result" && e.name === "rarebit_recall");
		assert.match(recall.text, /Add a health endpoint to the billing service/);
		assert.match(recall.text, /^2 of \d+ Rarebits match/, "the first request and the recall request itself");
		assert.deepEqual(client.gaps, [], "every replica applied a contiguous ops stream");
		client.close();
	} finally {
		await daemon.stop();
		delete process.env.AMPI_RAREBIT_MIN_TOKENS;
		delete process.env.AMPI_RAREBIT_MAX_RATIO;
		delete process.env.AMPI_COMPACT_KEEP_RECENT;
	}
});
