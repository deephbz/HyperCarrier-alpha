// Archive is reversible visibility state; it never erases stop authority. Unarchive refuses to reopen a thread
// until every stop its Archive or legacy Close requires has a receipt, and a failed metadata commit leaves memory
// equal to the durable state.
import "./bound.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { TeamDoc } from "@hypercarrier/pi-team-durable/authority";
import { runDaemon } from "../src/node/daemon.ts";
import { EscDoc, MetaDoc, type NodePlugin, parseThreadKey } from "../src/node/runtime.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

/** A plugin whose closing stop cannot store its receipt while `failing` holds. */
function failingPlugin() {
	const state = { failing: false, confirmed: [] as string[] };
	const plugin: NodePlugin = {
		extensions: [],
		closing: (_store, conversationId) => [{ id: `plugin:${conversationId}`, conversations: [conversationId] }],
		confirmStop: (_store, id) => {
			if (state.failing) throw new Error("receipt store unavailable");
			state.confirmed.push(id);
		},
	};
	return { state, plugin };
}

/** Runs `fn` while the archive metadata commit fails. */
async function failing(fn: () => Promise<void>): Promise<void> {
	process.env.AMPI_FAULT = "archive-commit";
	try { await fn(); } finally { delete process.env.AMPI_FAULT; }
}

function starts(log: string, conversationId: string): number {
	if (!existsSync(log)) return 0;
	return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.conversation === conversationId && (row.kind === "model" || row.kind === "tool")).length;
}

for (const lifecycle of ["archive", "close"] as const) {
	test(`unarchive after an unconfirmed ${lifecycle} stop refuses, keeps the mark, and starts no work`, async (t) => {
		const home = tempHome();
		const log = join(home, "entries.jsonl");
		process.env.AMPI_ENTRY_LOG = log;
		t.after(() => { delete process.env.AMPI_ENTRY_LOG; });
		const { state, plugin } = failingPlugin();
		const daemon = await runDaemon({ home, simTokensPerSecond: 5000, plugins: [plugin] });
		try {
			const client = await TestClient.connect(daemon.socket);
			const threads = client.sub({ kind: "threads" });
			const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim say first" });
			await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.live === true);
			const { conversationId } = parseThreadKey(threadId);
			state.failing = true;
			if (lifecycle === "archive") await assert.rejects(client.req("thread.archive", { threadId, archived: true }), code("archive_incomplete"));
			// Legacy Close reports only its own stop; the plugin stop stays without a receipt.
			else await client.req("thread.close", { threadId });
			const before = starts(log, conversationId);
			const { store } = await daemon.runtime.thread(threadId);
			const markBefore = (await store.harness.snapshot(MetaDoc, context))!.convs[conversationId];

			await assert.rejects(client.req("thread.archive", { threadId, archived: false }), code("stop_pending"), "Unarchive waits for the stop receipt");
			await assert.rejects(client.req("thread.submit", { threadId, content: "/sim say too-early" }), (error: { code?: string }) => error.code === "stop_pending" || error.code === "closed");
			await assert.rejects(client.req("thread.configure", { threadId, thinkingLevel: "low" }));
			const markAfter = (await store.harness.snapshot(MetaDoc, context))!.convs[conversationId];
			assert.deepEqual({ archived: markAfter?.archived, closed: markAfter?.closed }, { archived: markBefore?.archived, closed: markBefore?.closed }, "the stored mark is unchanged");
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(starts(log, conversationId), before, "no model call or tool started");

			state.failing = false;
			await client.req("thread.archive", { threadId, archived: false });
			assert.ok(state.confirmed.includes(`plugin:${conversationId}`), "the stop has its receipt");
			const row = await client.until<any>(threads, (v) => v.threads[threadId] && !v.threads[threadId].archived);
			assert.equal(row.threads[threadId].closed, undefined);
			const response = await client.req("thread.submit", { threadId, content: "/sim say after-receipt" });
			assert.equal(response.evidence, "started");
			client.close();
		} finally {
			await daemon.stop();
		}
	});
}

// Two stop owners fence one conversation. One owner's receipt must not lift the fence another owner still holds,
// in either resolution order, and a restart replays both holds. Admission returns only after the last receipt.
// A stored Esc stop replays through the node's own Esc confirmer on restart, so only the plugin owner repeats it.
const overlap = [
	...(["other-first", "held-first"] as const).flatMap((order) => [false, true].map((restart) => ({ owner: "plugin" as const, order, restart }))),
	...(["other-first", "held-first"] as const).map((order) => ({ owner: "stored Esc" as const, order, restart: false })),
];
for (const { owner, order, restart } of overlap) {
	test(`a pending ${owner} stop keeps its fence when ${order === "other-first" ? "the closing stop" : "it"} settles first${restart ? " across a restart" : ""}`, async (t) => {
		const home = tempHome();
		const log = join(home, "entries.jsonl");
		process.env.AMPI_ENTRY_LOG = log;
		t.after(() => { delete process.env.AMPI_ENTRY_LOG; });
		const closing = failingPlugin();
		const held = { failing: true, intents: [] as { id: string; conversations: string[] }[] };
		const holder: NodePlugin = {
			extensions: [],
			stops: () => held.intents,
			confirmStop: async (store, id, outcome) => {
				if (held.failing) throw new Error("receipt store unavailable");
				held.intents = held.intents.filter((intent) => intent.id !== id);
				if (owner === "stored Esc" && outcome.status === "settled")
					await store.harness.commit(async (tx) => { delete (await tx.doc(EscDoc)).intents[id]; }, context);
			},
		};
		const plugins = [closing.plugin, holder];
		let daemon = await runDaemon({ home, simTokensPerSecond: 5000, plugins });
		let client = await TestClient.connect(daemon.socket);
		try {
			let threads = client.sub({ kind: "threads" });
			const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim say first" });
			await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.live === true);
			const { conversationId } = parseThreadKey(threadId);
			const intent = { id: `held:${conversationId}`, conversations: [conversationId] };
			let { store } = await daemon.runtime.thread(threadId);
			if (owner === "stored Esc") await store.harness.commit(async (tx) => { (await tx.doc(EscDoc)).intents[intent.id] = intent; }, context);
			else held.intents = [intent];
			const [first] = await daemon.runtime.stop(store, [intent], holder);
			assert.equal(first?.status, "failed", "the held stop has no receipt");
			const admits = () => client.req("thread.configure", { threadId, thinkingLevel: "low" }).then(() => "open", (error: { code?: string }) => error.code);
			assert.equal(await admits(), "stopped");

			if (order === "other-first") {
				await client.req("thread.archive", { threadId, archived: true });
				assert.ok(closing.state.confirmed.includes(`plugin:${conversationId}`), "the closing stop settled");
			} else {
				closing.state.failing = true;
				await assert.rejects(client.req("thread.archive", { threadId, archived: true }), code("archive_incomplete"));
			}
			if (restart) {
				client.close();
				await daemon.stop();
				daemon = await runDaemon({ home, simTokensPerSecond: 5000, plugins });
				client = await TestClient.connect(daemon.socket);
				threads = client.sub({ kind: "threads" });
				await client.until<any>(threads, (v) => v.threads[threadId]?.archived === true);
				({ store } = await daemon.runtime.thread(threadId));
			}
			const before = starts(log, conversationId);
			const startsNothing = async () => {
				await assert.rejects(client.req("thread.submit", { threadId, content: "/sim say too-early" }));
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.equal(starts(log, conversationId), before, "no model call or tool started");
			};
			const releaseHeld = async () => {
				held.failing = false;
				const [released] = await daemon.runtime.stop(store, [intent], holder);
				assert.equal(released?.status, "settled");
			};

			if (order === "other-first") {
				await client.req("thread.archive", { threadId, archived: false });
				assert.equal(await admits(), "stopped", "the held fence survives Unarchive");
				await startsNothing();
				await releaseHeld();
			} else {
				await releaseHeld();
				assert.equal(await admits(), "archived", "the closing stop still holds the thread");
				await assert.rejects(client.req("thread.archive", { threadId, archived: false }), code("stop_pending"));
				await startsNothing();
				closing.state.failing = false;
				await client.req("thread.archive", { threadId, archived: false });
			}
			assert.equal(await admits(), "open", "admission returns after the last receipt");
			const response = await client.req("thread.submit", { threadId, content: "/sim say after-receipt" });
			assert.equal(response.evidence, "started");
		} finally {
			client.close();
			await daemon.stop();
		}
	});
}

test("a failed archive commit leaves memory equal to the durable state for the lead and its Workers", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 100_000, plugins: await hydrate() });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		await client.req("thread.submit", {
			threadId,
			content: '/sim tool team_create {"name":"archive-commit","purpose":"Check archive rollback"}\n/sim tool ensure_worker {"name":"builder","scope":"Build"}',
		});
		const thread = await daemon.runtime.thread(threadId);
		let workerId: string | undefined;
		for (let i = 0; i < 300 && !(workerId && daemon.runtime.threads.value.threads[threadId]?.activity === "idle"); i++) {
			const team = (await thread.store.harness.snapshot(TeamDoc, context)) as any;
			const worker = team?.current?.workers?.builder;
			if (worker) workerId = thread.store.threadKey(worker.conversationId);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(workerId, "the lead created its Worker");
		await client.until<any>(threads, (v) => v.threads[threadId]?.team?.role === "lead" && v.threads[workerId!]?.parentId === threadId);

		const archivedIn = async (key: string) => {
			const meta = await thread.store.harness.snapshot(MetaDoc, context);
			return meta?.convs[parseThreadKey(key).conversationId]?.archived === true;
		};
		const admits = async (key: string) => client.req("thread.configure", { threadId: key, thinkingLevel: "low" }).then(() => "open", (error: { code?: string }) => error.code);

		// A first Archive whose commit fails archives nothing, in memory as on disk.
		await failing(() => assert.rejects(client.req("thread.archive", { threadId, archived: true }), /disk full/));
		assert.equal(await archivedIn(workerId!), false);
		assert.notEqual(await admits(workerId!), "archived", "the Worker is not archived in memory");
		assert.notEqual(await admits(threadId), "archived", "the lead is not archived in memory");
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("a failed repeat archive commit keeps an existing archive in memory", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 5000 });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim say first" });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.live === true);
		await client.req("thread.archive", { threadId, archived: true });
		await failing(() => assert.rejects(client.req("thread.archive", { threadId, archived: true }), /disk full/));
		await assert.rejects(client.req("thread.configure", { threadId, thinkingLevel: "low" }), code("archived"), "the existing archive still holds in memory");
		await failing(() => assert.rejects(client.req("thread.archive", { threadId, archived: false }), /disk full/));
		await assert.rejects(client.req("thread.configure", { threadId, thinkingLevel: "low" }), code("archived"), "a failed Unarchive keeps the archive in memory");
		client.close();
	} finally {
		await daemon.stop();
	}
});
