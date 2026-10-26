import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { runDaemon } from "../src/node/daemon.ts";
import { projectViewFields } from "../src/node/projection.ts";
import { topics, type TopicHandler } from "../src/node/server.ts";
import { Hub } from "../src/hub/hub.ts";
import { Browser, tempHome } from "./helpers.ts";

// A durable thread window holds the hub copy's clipped entries. The node's thread topic carries every entry whole,
// so the hub asks it only for live and inbox: no subscription frame carries a large body to the hub.

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const TOKEN = "e".repeat(64);
const BODY = 2 << 20;
/** The bound on one thread subscription value from the node: live and inbox, far below one large body. */
const FRAME_BOUND = 64 << 10;

type Tapped = { threadId: string; fields?: string[]; bytes: number[] };

/** Wraps the node's thread topic to record the bytes of each value it publishes. `old` is a node that predates `fields`. */
function tapThreadTopic(t: any, { old = false } = {}): Tapped[] {
	const original = topics.get("thread")!;
	const tapped: Tapped[] = [];
	const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
	const handler: TopicHandler = async (topic, runtime) => {
		const asked = { ...topic } as Extract<typeof topic, { kind: "thread" }>;
		if (old) delete asked.fields;
		const row: Tapped = { threadId: asked.threadId, ...(asked.fields ? { fields: asked.fields } : {}), bytes: [] };
		tapped.push(row);
		const source = await original(asked, runtime);
		row.bytes.push(size(source.value));
		return { ...source, get value() { return source.value; }, subscribe: (listener) => source.subscribe((value) => { row.bytes.push(size(value)); listener(value); }) };
	};
	topics.set("thread", handler);
	t.after(() => topics.set("thread", original));
	return tapped;
}

/** A daemon and hub with one idle durable thread whose last answer is a native 2 MiB assistant entry. */
async function largeThread(t: any) {
	const home = tempHome();
	const daemon = await runDaemon({ home });
	const hub = new Hub({ hosts: [{ id: "devbox", label: "devbox", kind: "local", home }] }, { token: TOKEN });
	const port = await hub.listen(0);
	const b = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	t.after(async () => { b.ws.terminate(); await hub.close(); await daemon.stop(); });
	await b.when(() => b.hosts.some((h) => h.id === "devbox" && h.status === "connected"), 5000, "durable host");
	const { threadId } = await b.req("devbox", "thread.create", { requestId: "fields", cwd: home, model: SIM, prompt: "Hello", place: { workspace: "new", label: "main" } });
	await b.until<any>(b.sub("devbox", { kind: "threads" }), (v) => v.threads[threadId]?.activity === "idle");
	const { store, conversationId } = await daemon.runtime.thread(threadId) as any;
	await store.harness.commit((tx: any) => tx.appendEntry(Number(conversationId), { kind: "pi.assistant", model: [fauxAssistantMessage(`LARGE_BEGIN_${"x".repeat(BODY)}_END`)] }), context);
	return { b, threadId };
}

/** Opens the thread as a window does, and checks that the window works: clipped large entry, live and inbox, a new turn. */
async function openWindow(b: Browser, threadId: string) {
	const thread = b.sub("devbox", { kind: "thread", threadId });
	const value = await b.until<any>(thread, (v) => v.entries?.some((e: any) => e.blocks?.[0]?.text?.startsWith("LARGE_BEGIN_")), 20_000);
	const large = value.entries.find((e: any) => e.blocks?.[0]?.text?.startsWith("LARGE_BEGIN_"));
	assert.ok(large.blocks[0].text.length <= 16 << 10, "the window shows the hub copy's clipped entry");
	assert.ok(value.live && Array.isArray(value.inbox?.items), "live and inbox come from the node");
	await b.req("devbox", "thread.submit", { threadId, content: "Second question" });
	await b.until<any>(thread, (v) => v.entries?.some((e: any) => e.kind === "user" && e.text === "Second question"), 10_000);
	assert.deepEqual(b.gaps, []);
}

test("durable thread fields: the hub asks the node for live and inbox only, so no subscription frame carries a large body", async (t) => {
	const tapped = tapThreadTopic(t);
	const { b, threadId } = await largeThread(t);
	await openWindow(b, threadId);
	const subs = tapped.filter((s) => s.threadId === threadId);
	assert.ok(subs.length > 0, "the hub subscribed the node's thread topic");
	const largest = Math.max(...subs.flatMap((s) => s.bytes));
	assert.ok(largest < FRAME_BOUND, `largest thread value from the node: ${largest} bytes`);
	for (const s of subs) assert.deepEqual(s.fields, ["live", "inbox"]);
});

test("durable thread fields: a node that predates fields sends the full value, and the window still works", async (t) => {
	const tapped = tapThreadTopic(t, { old: true });
	const { b, threadId } = await largeThread(t);
	await openWindow(b, threadId);
	const subs = tapped.filter((s) => s.threadId === threadId);
	assert.ok(subs.length > 0 && subs.every((s) => s.fields === undefined));
	assert.ok(Math.max(...subs.flatMap((s) => s.bytes)) > BODY, "the old node's value carries the whole body");
});

test("durable thread fields: the fields projection reads no entry, and the node refuses an unknown field", async (t) => {
	const view = {
		conversation: { id: 1 },
		get entries(): never { throw new Error("read an entry"); },
		docs: { "pi.live": { activity: "idle" }, "pi.inbox": { items: [] } },
	} as never;
	assert.deepEqual(Object.keys(projectViewFields(view, undefined, ["live", "inbox"])), ["live", "inbox"]);
	assert.deepEqual(Object.keys(projectViewFields(view, undefined, ["inbox"])), ["inbox"]);

	const daemon = await runDaemon({ home: tempHome() });
	t.after(() => daemon.stop());
	await assert.rejects(topics.get("thread")!({ kind: "thread", threadId: "x.1", fields: ["entries"] } as never, daemon.runtime), /thread topic fields are live, inbox/);
});
