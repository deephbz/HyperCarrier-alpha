import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { type NodePlugin, parseThreadKey } from "../src/node/runtime.ts";
import type { StopIntent, StopOutcome } from "../src/node/stops.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

test("close: stores the intent, stops the run, returns queued input, and leaves a read-only thread a fork continues", async () => {
	const home = tempHome();
	const confirmed: [string, StopOutcome][] = [];
	let worker = "";
	const plugin: NodePlugin = {
		extensions: [],
		summarize: (_store, conversationId, summary) => {
			if (summary.id === worker) summary.team = { teamId: "t", role: "worker", worker: "w" };
			void conversationId;
		},
		closing: () => [{ id: "plugin-stop", tasks: [] }],
		confirmStop: (_store, id, outcome) => void confirmed.push([id, outcome]),
	};
	const daemon = await runDaemon({ home, simTokensPerSecond: 200, plugins: [plugin] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const a = await client.req("thread.create", { requestId: "close-a", cwd: home, model: SIM, place: { workspace: "new", label: "Work" }, prompt: "/sim long 200" });
		await client.until<any>(threads, (v) => v.threads[a.threadId]?.activity === "streaming");
		const queued = await client.req("thread.submit", { threadId: a.threadId, content: "queued text", whenBusy: "followUp" });

		const ack = await client.req("thread.close", { threadId: a.threadId });
		assert.equal(ack.via, "node");
		assert.equal(ack.evidence, "closed");
		assert.deepEqual(ack.submissions.map((s: any) => [s.submission, s.state, s.text]), [[queued.submission, "returned", "queued text"]]);
		assert.deepEqual(confirmed.map(([id, outcome]) => [id, outcome.status]), [["plugin-stop", "settled"]], "a plugin's stop runs with the Close");
		const closed = await client.until<any>(threads, (v) => v.threads[a.threadId]?.closed && v.threads[a.threadId].activity === "idle");
		const row = closed.threads[a.threadId];
		assert.equal(row.live, false, "Close ends live");
		assert.equal(row.location, undefined, "a closed thread is in no tab");
		assert.equal(closed.layout.workspaces.some((w: any) => w.tabs[0].panes.includes(a.threadId)), false);

		// Read-only: writes answer `closed`; reads keep working; Resume does not exist.
		await assert.rejects(client.req("thread.submit", { threadId: a.threadId, content: "more" }), code("closed"));
		await assert.rejects(client.req("thread.compact", { threadId: a.threadId }), code("closed"));
		await assert.rejects(client.req("thread.configure", { threadId: a.threadId, thinkingLevel: "low" }), code("closed"));
		await assert.rejects(client.req("thread.resume", { threadId: a.threadId, requestId: "r", place: { workspace: "new" } }), code("unsupported"));
		const history = await client.req("thread.history", { threadId: a.threadId, before: "1000000", limit: 50 });
		assert.ok(history.entries.some((e: any) => e.kind === "user"));
		assert.equal(history.entries.some((e: any) => e.kind === "assistant" && e.stop === "stop"), false, "the run never finished");
		assert.deepEqual(await client.req("thread.close", { threadId: a.threadId }), { via: "node", evidence: "closed", submissions: [] }, "Close is idempotent");

		// A fork of a closed thread is a new, writable thread in the same tab.
		const fork = await client.req("thread.fork", { threadId: a.threadId, entryId: String(history.entries[0].id) });
		const forked = await client.req("thread.submit", { threadId: fork.threadId, content: "continue here" });
		assert.equal(forked.via, "node");
		const open = await client.until<any>(threads, (v) => v.threads[fork.threadId]?.live === true);
		assert.equal(open.threads[fork.threadId].location.workspaceLabel, "Work");
		await client.req("thread.abort", { threadId: fork.threadId });

		// A Team Worker closes through its lead.
		const w = await client.req("thread.create", { requestId: "close-w", cwd: home, model: SIM });
		worker = w.threadId;
		await client.req("thread.rename", { threadId: w.threadId, title: "worker" });
		await client.until<any>(threads, (v) => v.threads[w.threadId]?.team?.role === "worker");
		await assert.rejects(client.req("thread.close", { threadId: w.threadId }), code("team_worker"));
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("stop fence: a stop whose confirmStop throws keeps its fence until a later open confirms it", async () => {
	const home = tempHome();
	const pending: StopIntent[] = [];
	let failures = 1;
	let confirmed!: () => void;
	const confirmedOnce = new Promise<void>((resolve) => (confirmed = resolve));
	const plugin: NodePlugin = {
		extensions: [],
		stops: () => [...pending],
		confirmStop: (_store, id) => {
			if (failures-- > 0) throw new Error("receipt store unavailable");
			pending.splice(pending.findIndex((intent) => intent.id === id), 1);
			confirmed();
		},
	};
	let daemon = await runDaemon({ home, simTokensPerSecond: 5000, plugins: [plugin] });
	try {
		let client = await TestClient.connect(daemon.socket);
		const { threadId } = await client.req("thread.create", { requestId: "fence-a", cwd: home, model: SIM, place: { workspace: "new", label: "F" } });
		const { storeId, conversationId } = parseThreadKey(threadId);
		const intent = { id: "worker-stop", conversations: [conversationId] };
		pending.push(intent);
		const [outcome] = await daemon.runtime.stop(daemon.runtime.store(storeId), [intent], plugin);
		assert.equal(outcome.status, "failed", "a failed confirmation is a failed stop");
		await assert.rejects(client.req("thread.submit", { threadId, content: "too early" }), code("stopped"), "the fence holds while the stop is unconfirmed");
		client.close();
		await daemon.stop();

		daemon = await runDaemon({ home, simTokensPerSecond: 5000, plugins: [plugin] });
		await confirmedOnce;
		assert.deepEqual(pending, [], "the next open confirmed the stored stop");
		client = await TestClient.connect(daemon.socket);
		assert.equal((await client.req("thread.submit", { threadId, content: "after the receipt" })).via, "node", "the confirmed stop lifts the fence");
		client.close();
	} finally {
		await daemon.stop();
	}
});
