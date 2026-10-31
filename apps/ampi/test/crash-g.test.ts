import "./bound.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RarebitDoc } from "@hypercarrier/rarebit-durable";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, writePiSettings } from "./helpers.ts";
import { parseThreadKey } from "../src/node/runtime.ts";
import { tempHome } from "./helpers.ts";
import { kill, SIM, startNode } from "./crash-fixtures.ts";

type Entry = { kind: "model" | "tool" | "compact"; store: string; conversation: string; task: string };
const entries = (path: string): Entry[] =>
	existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

for (const name of ["compact", "auto-compact"]) test(`crash-g: /${name} recovers one compaction after admission loses its reply`, async () => {
	const home = tempHome();
	const log = join(home, "entries.jsonl");
	// A short verbatim tail, so one long answer is enough to compact.
	writePiSettings({ compaction: { keepRecentTokens: 200 } });
	// The fault kills the node right after `conversation.compact` returns: the intent is stored, the reply is not.
	let { child, client } = await startNode(home, 5000, { AMPI_FAULT: "after-command-effect", AMPI_ENTRY_LOG: log });
	try {
		const threads = client.sub({ kind: "threads" });
		const a = await client.req("thread.create", { requestId: "crash-g", cwd: home, model: SIM, place: { workspace: "new", label: "G" }, prompt: "/sim long 10" });
		await client.until<any>(threads, (v) => v.threads[a.threadId]?.activity === "idle" && v.threads[a.threadId].preview, 20_000);
		const exited = new Promise((resolve) => child.once("exit", resolve));
		const frame = { threadId: a.threadId, name, args: name === "auto-compact" ? "run keep decisions" : "keep decisions", key: "k1" };
		const lost = client.req("thread.command", frame).then(
			() => "replied",
			() => "lost",
		);
		assert.equal(await Promise.race([exited.then(() => "exited"), lost.then((r) => `reply ${r}`)]), "exited", "the node dies before it replies");
		client.close();

		({ child, client } = await startNode(home, 5000, { AMPI_ENTRY_LOG: log }));
		const retry = await client.req("thread.command", frame);
		assert.deepEqual([retry.via, retry.disposition, retry.evidence], ["node", "handled", "compaction_started"]);
		assert.deepEqual(await client.req("thread.command", frame), retry, "the stored reply answers later retries");

		const { storeId, conversationId } = parseThreadKey(a.threadId);
		const health = await client.req("node.health");
		const live = health.stores.find((s: any) => s.id === storeId).tasks.filter((t: any) => t.kind === "pi.compaction" && t.conversation === conversationId);
		const started = entries(log).filter((e) => e.kind === "compact" && e.store === storeId && e.conversation === conversationId);
		const ids = new Set([...live.map((t: any) => t.id), ...started.map((e) => e.task)]);
		assert.equal(ids.size, 1, `exactly one compaction task ran or waits: ${[...ids].join(", ")}`);
		const view = client.sub({ kind: "thread", threadId: a.threadId });
		const done = await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 20_000);
		assert.equal(done.entries.filter((e: any) => e.kind === "compaction").length, 1, "one compaction entry");
		client.close();
	} finally {
		await kill(child);
		writePiSettings(undefined);
	}
});

for (const action of ["title"]) for (const cut of ["intent", "response", "result"])
test(`Rarebit ${action}: crash after ${cut} never repeats keyed model spend`, async () => {
	const home = tempHome();
	const { child, client } = await startNode(home, 50_000, { AMPI_FAULT: `after-rarebit-command-${cut}` });
	let daemon: Awaited<ReturnType<typeof runDaemon>> | undefined;
	let recovered: TestClient | undefined;
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Build a receipt audit" });
		const topic = client.sub({ kind: "rarebit", threadId });
		await client.until<any>(topic, v => v.state.title);
		const frame = { threadId, name: "rarebit", args: action, key: "one-spend" };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const exited = new Promise<void>((resolve, reject) => {
			child.once("exit", () => { clearTimeout(timer); resolve(); });
			timer = setTimeout(() => reject(new Error("Fault did not cut off the command")), 1500);
		});
		void client.req("thread.command", frame).catch(() => {});
		await exited;
		client.close();
		let calls = 0;
		daemon = await runDaemon({ home, simTokensPerSecond: 50_000, plugins: [...await hydrate(), {
			extensions: [], attach(_store, runtime) {
				const complete = runtime.models.completeSimple.bind(runtime.models);
				runtime.models.completeSimple = (...args) => { calls++; return complete(...args); };
			},
		}] });
		recovered = await TestClient.connect(daemon.socket);
		const ack = await recovered.req("thread.command", frame);
		if (cut === "result") assert.match(ack.notice, /Title derived/);
		else assert.match(ack.notice, /interrupted; the result is unknown/);
		assert.equal(calls, 0, "recovery and replay make no Rarebit model request");
		const thread = await daemon.runtime.thread(threadId);
		const state = await thread.store.harness.snapshot(RarebitDoc, thread.conversation.id, BACKGROUND_CONTEXT);
		assert.equal(Boolean(state?.commands?.["one-spend"]?.result), cut === "result");
		await recovered.req("thread.command", { ...frame, key: "owner-retry" });
		assert.equal(calls, 1, "a fresh explicit command can try again");
		const after = await thread.store.harness.snapshot(RarebitDoc, thread.conversation.id, BACKGROUND_CONTEXT);
		assert.equal(Boolean(after?.commands?.["one-spend"]?.result), cut === "result", "new work never claims an interrupted command's result");
	} finally { client.close(); recovered?.close(); await daemon?.stop(); await kill(child); }
});
