import "./bound.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { runDaemon } from "../src/node/daemon.ts";
import { teamPlugin } from "../src/plugins/team.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseThreadKey } from "../src/node/runtime.ts";
import { TestClient, tempHome } from "./helpers.ts";
import { kill, SIM, startNode } from "./crash-fixtures.ts";
import { CrashChild } from "./durable-l2/process.ts";

type Entry = { kind: string; store: string; conversation?: string; name?: string; intent?: string; tasks?: string[] };
const entries = (path: string): Entry[] =>
	existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// review-milestone-1-systems.md, pushback 1: a slow Worker stop must not let other stopped work run on.
test("crash-team-shutdown: live team_shutdown marks every stop before it settles any; a kill in between runs nothing again", async () => {
	const home = tempHome();
	const before = join(home, "entries-before.jsonl"), after = join(home, "entries-after.jsonl"), release = join(home, "release");
	const stopsBefore = join(home, "stops-before.jsonl"), stopsAfter = join(home, "stops-after.jsonl");
	// The latch holds every settlement, as a Worker abort that does not complete would. Marks never wait for it.
	const seed = new CrashChild(home, "shutdown", "seed", new URL("./shutdown-crash-node.ts", import.meta.url));
	let child = seed.child;
	let client: TestClient | undefined;
	try {
		const { socket } = (await seed.wait("ready", undefined, 30_000)).value;
		client = await TestClient.connect(socket);
		const prompt = ['/sim tool team_create {"name":"stop","purpose":"Stop order"}', '/sim tool ensure_worker {"name":"alice","scope":"A"}', '/sim tool ensure_worker {"name":"bob","scope":"B"}'].join("\n");
		const lead = await client.req("thread.create", { requestId: "crash-ts", cwd: home, model: SIM, place: { workspace: "new", label: "T" }, prompt });
		const threads = client.sub({ kind: "threads" });
		const list = await client.until<any>(threads, (v) => Object.values(v.threads).filter((t: any) => t.kind === "worker").length === 2 && v.threads[lead.threadId].activity === "idle", 20_000);
		const worker = (name: string) => (Object.values(list.threads) as any[]).find((t) => t.team?.worker === name).id as string;
		const [a, b] = [worker("alice"), worker("bob")];
		const store = parseThreadKey(lead.threadId).storeId;
		const conv = (id: string) => parseThreadKey(id).conversationId;
		const ran = (path: string, id: string) => entries(path).filter((e) => e.store === store && e.conversation === conv(id) && (e.kind === "model" || e.kind === "tool"));
		// A holds a long tool. B's next model request and tool are due as soon as its short tool ends.
		await client.req("thread.submit", { threadId: a, content: "/sim bash sleep 30" });
		await client.req("thread.submit", { threadId: b, content: "/sim bash sleep 0.5\n/sim bash echo b-after" });
		for (const id of [a, b]) await waitFor(() => ran(before, id).some((e) => e.kind === "tool" && e.name === "bash"), `${id} started its tool`);
		const bStarted = Date.now();
		const seen = { a: ran(before, a).length, b: ran(before, b).length };

		await client.req("thread.submit", { threadId: lead.threadId, content: "/sim tool team_shutdown {}" });
		const marks = () => entries(stopsBefore).filter((e) => e.store === store && e.kind === "mark");
		await waitFor(() => marks().length >= 3, "all three stops marked");
		const byIntent = Object.fromEntries(marks().map((e) => [e.intent!.replace(/^.*:stop:|^.*:/, ""), e]));
		assert.deepEqual(Object.keys(byIntent).sort(), ["alice:g1", "bob:g1", "shutdown-mechanics"]);
		seed.child.send({ command: "snapshot", threadId: lead.threadId });
		const stored = (await seed.wait("snapshot")).value;
		assert.ok(stored.current.notifierId, "the Team has a notifier");
		// A notifier can finish before markStops scans live tasks. Its persisted target must still exist.
		assert.ok(stored.stops[byIntent["shutdown-mechanics"]!.intent!].tasks.includes(stored.current.notifierId), "the stored shutdown intent names the notifier");
		for (const name of ["alice", "bob"]) {
			const worker = stored.current.workers[name];
			const intent = stored.stops[byIntent[`${name}:g1`]!.intent!];
			assert.ok(intent.tasks.includes(worker.anchorId), `the stored stop intent names ${name}'s anchor`);
			assert.ok(intent.conversations.includes(worker.conversationId), `the stored stop intent names ${name}'s conversation`);
		}
		// Hold the latch past the end of B's short tool: unmarked, B would request the model and run `echo` now.
		await sleep(Math.max(0, bStarted + 1000 - Date.now()));
		assert.deepEqual(entries(stopsBefore).filter((e) => e.kind === "settled"), [], "the latch held every settlement");
		assert.equal(ran(before, a).length, seen.a, "A starts nothing after the stop");
		assert.equal(ran(before, b).length, seen.b, "B starts no model request or tool after the stop");
		client.close();
		await kill(child);

		({ child, client } = await startNode(home, 2000, { AMPI_ENTRY_LOG: after, AMPI_STOP_LOG: stopsAfter }));
		const team = client.sub({ kind: "team", teamId: lead.threadId });
		const stopped = await client.until<any>(team, (v) => v.team?.status === "stopped", 20_000);
		assert.deepEqual(stopped.workers.map((w: any) => w.membership.active), [false, false]);
		const reopened = entries(stopsAfter).filter((e) => e.store === store);
		const firstSettle = reopened.findIndex((e) => e.kind === "settled");
		assert.ok(reopened.slice(0, firstSettle).filter((e) => e.kind === "mark").length >= 3, "reopen marks every stored stop before it settles one");
		assert.deepEqual([...ran(after, a), ...ran(after, b)], [], "no Worker model request or tool starts after the restart");
		client.close();
	} finally {
		writeFileSync(release, "");
		client?.close();
		await kill(child);
		await seed.exited;
	}
});

test("non-cooperative delivery: every stop mark precedes crash recovery and no Worker starts", async (t) => {
	const proof = tempHome();
	await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./durable-l4/integration-pending.mjs", import.meta.url))], {
		env: { ...process.env, AMPI_PENDING_NONCOOPERATIVE: "1", AMPI_INTEGRATION_PROOF: proof },
		// Whole-fixture hang watchdog matches the runner. Startup and cleanup are not mark latency.
		timeout: Number(process.env.AMPI_TEST_TIMEOUT_MS ?? 60_000),
	});
	const receipt = JSON.parse(readFileSync(join(proof, "receipt.json"), "utf8"));
	assert.equal(receipt.ok, true);
	assert.equal(receipt.spendUsd, 0);
	// The child enforces each mark budget after setup and keeps total wall time only for diagnosis.
	t.diagnostic(JSON.stringify({ liveMarksMs: receipt.liveMarksMs, recoveryMarksMs: receipt.recoveryMarksMs, wallMs: receipt.wallMs }));
});

test("a timed-out Worker stop completes in the background when its non-cooperative tool ends", async () => {
	let release!: () => void, entered!: () => void;
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	const running = new Promise<void>((resolve) => { entered = resolve; });
	const hold = defineTool({
		name: "hold", description: "Hold a non-cooperative test invocation", parameters: Type.Object({}), replay: "safe",
		execute: async () => { entered(); await barrier; return { output: [{ type: "text", text: "released" }] }; },
	});
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 1e9, plugins: [teamPlugin(), { extensions: [defineExtension({ name: "hold-test", tools: [hold] })] }] });
	const client = await TestClient.connect(daemon.socket);
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: [
			'/sim tool team_create {"name":"bounded","purpose":"Bound stop waits"}',
			'/sim tool ensure_worker {"name":"alice","scope":"A"}',
			'/sim tool ensure_worker {"name":"bob","scope":"B"}',
		].join("\n") });
		const team = client.sub({ kind: "team", teamId: threadId });
		const ready = await client.until<any>(team, (v) => v.workers?.length === 2, 2000);
		const alice = ready.workers.find((w: any) => w.name === "alice").threadId;
		await client.req("thread.submit", { threadId: alice, content: "/sim tool hold {}" });
		await running;
		const view = client.sub({ kind: "thread", threadId });
		const started = Date.now();
		await client.req("thread.submit", { threadId, content: "/sim tool team_shutdown {}" });
		const partial = await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "tool-result" && e.name === "team_shutdown" && e.text.includes('"partial"')), 2500);
		assert.ok(Date.now() - started < 2000, "the lead does not join the stuck Worker");
		const text = partial.entries.find((e: any) => e.kind === "tool-result" && e.name === "team_shutdown").text;
		assert.match(text, /Still stopping: alice/);
		assert.match(text, /stop is recorded and no new work starts/);
		const stopping = await client.until<any>(team, (v) => v.workers.some((w: any) => w.name === "bob" && w.membership.deactivationReason === "stopped"), 1000);
		assert.equal(stopping.workers.find((w: any) => w.name === "alice").membership.deactivationReason, "stopping");
		await assert.rejects(client.req("thread.submit", { threadId: alice, content: "must not start" }), /stop/i);
		release();
		const stopped = await client.until<any>(team, (v) => v.team?.status === "stopped", 2000);
		assert.ok(stopped.workers.every((w: any) => w.membership.deactivationReason === "stopped"), "settlement needs no lead action");
		await client.req("thread.submit", { threadId, content: "/sim tool team_shutdown {}" });
		await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "tool-result" && e.name === "team_shutdown" && e.text.includes('"lifecycle":"stopped"')), 2000);
	} finally {
		release(); client.close(); await daemon.stop();
	}
});

async function waitFor(check: () => boolean, what: string, ms = 20_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
		await sleep(25);
	}
}
