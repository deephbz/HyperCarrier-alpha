import assert from "node:assert/strict";
import { test } from "node:test";
import { Hub, hubProof } from "../src/hub/hub.ts";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { Browser, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const TOKEN = "a".repeat(64);


test("hub: replicas stay exact through compaction, a repeated sub never doubles a stream, foreign origins are refused", async () => {
	process.env.AMPI_WORKING_BUDGET = "2500";
	process.env.AMPI_COMPACT_KEEP_RECENT = "200";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: await hydrate() });
	const hub = new Hub({ hosts: [{ id: "local", label: "Local", kind: "local", home }] }, { token: TOKEN });
	const port = await hub.listen(0);
	try {
		const KEY = (p: number) => `ampi_k_${p}=${TOKEN}`;
		await assert.rejects(Browser.open(port, "https://evil.example", KEY(port)), /HTTP 403/);
		await assert.rejects(Browser.open(port, "http://127.0.0.1:5999", KEY(port)), /HTTP 403/, "another local page is not the hub's own page");
		await assert.rejects(Browser.open(port, undefined, KEY(port + 1)), /HTTP 403/, "a cookie for another port is not this hub's key");
		// A local process that sends no Origin is not trusted either: it needs the owner's access key.
		await assert.rejects(Browser.open(port, undefined), /HTTP 403/);
		await assert.rejects(Browser.open(port, undefined, `ampi_k_${port}=${"b".repeat(64)}`), /HTTP 403/);
		// The page learns the key once from `?k=` and keeps it in an HttpOnly cookie.
		const login = await fetch(`http://127.0.0.1:${port}/?k=${TOKEN}`, { redirect: "manual" });
		assert.equal(login.status, 303);
		assert.equal(login.headers.get("location"), "/");
		assert.match(login.headers.get("set-cookie") ?? "", new RegExp(`^${KEY(port)}; HttpOnly; SameSite=Strict`));
		assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(), { ok: true, proof: hubProof(TOKEN) }, "health reveals nothing but a proof");
		const browser = await Browser.open(port, undefined, KEY(port));
		const threads = browser.sub("local", { kind: "threads" });
		await browser.until(threads, () => true);
		const create = { cwd: home, model: SIM, prompt: "first\n/sim long 4", requestId: "create-once" };
		const { threadId } = await browser.req("local", "thread.create", create);
		// A retried create (lost response, double submit) finds the same thread and does not resubmit its prompt.
		const again = await Promise.all([browser.req("local", "thread.create", create), browser.req("local", "thread.create", create)]);
		assert.deepEqual(again.map((r) => r.threadId), [threadId, threadId]);
		// The same sid subscribed twice (a reconnect replay): the hub must keep exactly one node stream for it.
		const view = browser.sub("local", { kind: "thread", threadId }, 9001);
		browser.sub("local", { kind: "thread", threadId }, 9001);
		for (const content of ["two\n/sim long 4", "three\n/sim long 4", "four\n/sim long 4"]) {
			await browser.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.queued === 0);
			await browser.req("local", "thread.submit", { threadId, content });
			await new Promise((r) => setTimeout(r, 300));
		}
		const compacted = await browser.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 20_000);
		await browser.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.queued === 0);
		await new Promise((r) => setTimeout(r, 500));
		const replica = browser.values.get(view) as any;
		const fresh = await browser.until<any>(browser.sub("local", { kind: "thread", threadId }), () => true);
		assert.deepEqual(
			replica.entries.map((e: any) => e.id),
			fresh.entries.map((e: any) => e.id),
			"the replica matches a fresh snapshot after compaction",
		);
		assert.ok(compacted.entries.length < 12);
		assert.deepEqual(new Set(replica.entries.map((e: any) => e.id)).size, replica.entries.length, "no duplicated entries");
		assert.deepEqual(browser.gaps, []);
		const index = browser.values.get(threads) as any;
		assert.equal(Object.values(index.threads).filter((t: any) => t.kind === "thread").length, 1, "one thread, not three");
		const history = await browser.req("local", "thread.history", { threadId, before: "1000000", limit: 500 });
		assert.equal(history.entries.filter((e: any) => e.kind === "user" && e.text.startsWith("first")).length, 1, "the prompt ran once");
		browser.ws.close();
	} finally {
		await hub.close();
		await daemon.stop();
		delete process.env.AMPI_WORKING_BUDGET;
		delete process.env.AMPI_COMPACT_KEEP_RECENT;
	}
});
