import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

test("a lead plans a Team; Workers claim and finish their Tasks in dependency order", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate() });
	try {
		const client = await TestClient.connect(daemon.socket);
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim team Ship the endpoint" });
		const team = client.sub({ kind: "team", teamId: threadId });
		const done = await client.until<any>(team, (v) => v.tasks?.length === 3 && v.tasks.every((t: any) => t.derived === "goal_achieved") && v.deliveries.every((d: any) => d.settled), 30_000);
		assert.deepEqual(done.workers.map((w: any) => w.name).sort(), ["alice", "bob"]);
		const docs = done.tasks.find((t: any) => t.key === "docs");
		const api = done.tasks.find((t: any) => t.key === "api");
		assert.ok(docs.attempts[0].startedAt >= api.attempts[0].endedAt, "docs started only after api achieved its goal");
		assert.match(api.evidence, /worker evidence for api/);
		// Acceptance and delivery are separate recorded facts.
		const taskDeliveries = done.deliveries.filter((d: any) => d.kind === "task");
		assert.equal(taskDeliveries.length, 3);
		for (const d of taskDeliveries) assert.ok(d.submittedAt >= d.acceptedAt && d.settled === "answered", JSON.stringify(d));
		// Worker subthreads appear in the thread index under the lead.
		const threads = client.sub({ kind: "threads" });
		const list = await client.until<any>(threads, (v) => Object.values(v.threads).filter((t: any) => t.kind === "worker").length === 2);
		const workers = Object.values(list.threads).filter((t: any) => t.kind === "worker") as any[];
		for (const w of workers) assert.equal(w.parentId, threadId);
		// The worker transcript shows the notice as a Team notice, not as human input.
		const view = client.sub({ kind: "thread", threadId: workers[0].id });
		const wv = await client.until<any>(view, (v) => v.entries.length > 0);
		assert.ok(wv.entries.some((e: any) => e.kind === "custom" && e.entryKind === "team.notice"));
		assert.ok(!wv.entries.some((e: any) => e.kind === "user"));
		assert.deepEqual(client.gaps, [], "every replica applied a contiguous ops stream");
		client.close();
	} finally {
		await daemon.stop();
	}
});
