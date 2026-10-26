import "./bound.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { get, type IncomingMessage } from "node:http";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
// @ts-ignore: shared reader is plain ESM.
import { createReaderService } from "../../trace-analytics/src/sources/durable-wire.mjs";
import { runDaemon } from "../src/node/daemon.ts";
import { readerStats } from "../src/node/server.ts";
import { Hub } from "../src/hub/hub.ts";
import { Browser, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const TOKEN = "e".repeat(64);

async function setup(t: any) {
	const home = tempHome();
	const daemon = await runDaemon({ home });
	const hub = new Hub({ hosts: [{ id: "devbox", label: "devbox", kind: "local", home }] }, { token: TOKEN });
	const port = await hub.listen(0);
	const browsers: Browser[] = [];
	const browser = async () => {
		const b = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
		browsers.push(b);
		await b.when(() => b.hosts.some((h) => h.id === "devbox" && h.status === "connected"), 5000, "durable host");
		return b;
	};
	t.after(async () => { for (const b of browsers) b.ws.terminate(); await hub.close(); await daemon.stop(); });
	const handles = () => readerStats(daemon.runtime).handles;
	const settle = async (want: number) => {
		for (const deadline = Date.now() + 3000; handles() !== want && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 10));
		assert.equal(handles(), want);
	};
	return { home, daemon, port, browser, handles, settle };
}

test("durable host: rows take the reader's spend and citation; the thread topic is the reader's value with the node's live and inbox", async (t) => {
	const { home, browser, settle } = await setup(t);
	const b = await browser();
	const threads = b.sub("devbox", { kind: "threads" });
	const { threadId } = await b.req("devbox", "thread.create", { requestId: "dh", cwd: home, model: SIM, prompt: "Hello", place: { workspace: "new", label: "main" } });
	// Every row value the browser sees: a row states no cost fact before the copy derived it.
	const seen: any[] = [];
	const list = await b.until<any>(threads, (v) => { if (v.threads[threadId]) seen.push(v.threads[threadId]); return v.threads[threadId]?.activity === "idle" && v.threads[threadId].spend?.usd === 0; });
	// Before the first priced response a row reads "no price reported"; no row is left without a label for the web to print as $0.
	assert.ok(seen.every((r) => r.spend === undefined ? r.spendLabel === undefined : r.spendLabel === (r.spend.usd === null ? "no price reported" : "$0")), JSON.stringify(seen.map((r) => [r.spend, r.spendLabel])));
	const row = list.threads[threadId];
	assert.equal(row.ref, `devbox/pi-durable:${threadId}`);
	assert.equal(row.spendLabel, "$0");
	assert.deepEqual(row.spend.covers, ["responses", "failed", "compaction", "tools"]);
	assert.equal(row.backend ?? list.backend, "durable");
	// No browser watches the thread: its sync closed the handle.
	await settle(0);

	const thread = b.sub("devbox", { kind: "thread", threadId });
	const value = await b.until<any>(thread, (v) => v.entries?.some((e: any) => e.kind === "assistant"));
	assert.equal(value.conversationId, threadId);
	assert.ok(value.live && Array.isArray(value.inbox.items), "live and inbox come from the node");
	assert.ok(typeof value.sourceVersion === "string", "the reader's source version");
	await settle(1);

	// Reads come from the hub copy.
	const search = await b.req("devbox", "sessions.search", { query: "Hello" });
	assert.ok(search.hits.some((h: any) => h.threadId === threadId), JSON.stringify(search));
	assert.equal(search.hostStatus, "connected", "search reports the link's status");
	const find = await b.req("devbox", "thread.find", { threadId, query: "Hello" });
	assert.ok(find.hits.length > 0);
	// A citation's thread segment (`pi-durable:<id>`) names the same thread in ops and topics.
	const [, cited, entry] = /^[^/]+\/([^#]+)#(.+)$/.exec(find.hits[0].ref)!;
	assert.equal(cited, `pi-durable:${threadId}`);
	const page = await b.req("devbox", "thread.entry", { threadId: cited, entry });
	assert.ok(typeof page.text === "string" && page.text.length > 0, JSON.stringify(page).slice(0, 300));
	const viaCite = await b.until<any>(b.sub("devbox", { kind: "thread", threadId: cited }), (v) => v.entries?.some((e: any) => e.kind === "assistant"));
	assert.equal(viaCite.conversationId, threadId);

	// A live turn reaches the held copy through the watch.
	await b.req("devbox", "thread.submit", { threadId, content: "Second question" });
	await b.until<any>(thread, (v) => v.entries?.some((e: any) => e.kind === "user" && e.text === "Second question"));
	assert.deepEqual(b.gaps, []);
});

test("durable host: thread holds are counted per subscriber, and the last browser socket close returns the node handles to zero", async (t) => {
	const { home, browser, settle } = await setup(t);
	const a = await browser(), c = await browser();
	const threads = a.sub("devbox", { kind: "threads" });
	const { threadId } = await a.req("devbox", "thread.create", { requestId: "dh2", cwd: home, model: SIM, prompt: "Hello", place: { workspace: "new", label: "main" } });
	await a.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].spendLabel);
	const one = a.sub("devbox", { kind: "thread", threadId });
	const two = c.sub("devbox", { kind: "thread", threadId });
	await a.until<any>(one, (v) => v.entries?.length > 0);
	await c.until<any>(two, (v) => v.entries?.length > 0);
	await settle(1);
	a.ws.send(JSON.stringify({ t: "unsub", sid: one }));
	await new Promise((r) => setTimeout(r, 100));
	await settle(1);
	c.ws.close();
	await settle(0);
});

/** The node's digest of a thread's entry of `kind`, from a reader connection of its own. */
async function nodeDigest(daemon: Awaited<ReturnType<typeof runDaemon>>, threadId: string, kind: string): Promise<string> {
	const reader = createReaderService({ context, epoch: 1, resolve: async (id: string) => (await daemon.runtime.thread(id)).conversation }).connect();
	const { handle } = await reader.open({ threadId });
	try {
		const { upper } = await reader.fence({ handle });
		const page = await reader.entries({ handle, order: "descending", limit: 5, maxEntryId: upper });
		return page.items.find((item: any) => item.kind === kind).sha256;
	} finally {
		await reader.close({ handle });
	}
}

/** A GET on the hub; `cookie: false` sends no login cookie. */
const fetchRaw = (port: number, path: string, cookie = true) => new Promise<IncomingMessage>((resolve, reject) => {
	get({ host: "127.0.0.1", port, path, headers: cookie ? { cookie: `ampi_k_${port}=${TOKEN}` } : {} }, resolve).on("error", reject);
});

test("durable host: the raw export streams an oversized entry over the reader wire, and a client abort closes the node handle", async (t) => {
	const { daemon, port, browser, handles, settle } = await setup(t);
	const b = await browser();
	const { threadId } = await b.req("devbox", "thread.create", { requestId: "raw", cwd: tempHome(), model: SIM, prompt: "Hello", place: { workspace: "new", label: "main" } });
	await b.until<any>(b.sub("devbox", { kind: "threads" }), (v) => v.threads[threadId]?.activity === "idle");
	// Past the hub copy's 16 MiB entry bound: the transcript holds a placeholder that links the raw export.
	const blob = "x".repeat(17 << 20);
	const { conversation } = await daemon.runtime.thread(threadId);
	await (await conversation.submit({ type: "write", entry: { kind: "fixture.blob", data: { blob } } } as never, context)).wait(context);
	const thread = b.sub("devbox", { kind: "thread", threadId });
	const value = await b.until<any>(thread, (v) => v.entries?.some((e: any) => e.entryKind === "fixture.blob"), 20_000);
	const stub = value.entries.find((e: any) => e.entryKind === "fixture.blob");
	const link = stub.rawExport;
	assert.equal(link, `/raw/pi-durable:${threadId}?host=${encodeURIComponent("devbox#durable")}`);
	b.ws.send(JSON.stringify({ t: "unsub", sid: thread }));
	await settle(0);

	assert.equal((await fetchRaw(port, link!, false)).statusCode, 401, "the raw export needs the hub login");
	assert.equal((await fetchRaw(port, `/raw/pi-durable:tree-a.999999?host=devbox`)).statusCode, 404);

	const res = await fetchRaw(port, link!);
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers["content-type"], "application/x-ndjson");
	const body = await new Promise<Buffer>((resolve, reject) => { const parts: Buffer[] = []; res.on("data", (c) => parts.push(c)).on("end", () => resolve(Buffer.concat(parts))).on("error", reject); });
	const lines = body.toString("utf8").split("\n").filter(Boolean);
	const line = lines.find((l) => l.includes('"fixture.blob"'))!;
	const record = JSON.parse(line);
	assert.equal(record.kind, "fixture.blob");
	assert.equal(record.data.blob.length, blob.length, "the whole body, from raw chunks");
	assert.equal(createHash("sha256").update(line).digest("hex"), await nodeDigest(daemon, threadId, "fixture.blob"), "the bytes the node stores");
	assert.ok(lines.every((l) => JSON.parse(l).id !== undefined), "every line is one durable record");
	await settle(0);

	// A client that closes mid-body ends the export; the node handle closes.
	const aborted = await fetchRaw(port, link!);
	await new Promise<void>((resolve) => aborted.once("data", () => resolve()));
	assert.equal(handles(), 1, "the export holds one node handle while it streams");
	aborted.destroy();
	await settle(0);
	assert.deepEqual(b.gaps, []);
});
