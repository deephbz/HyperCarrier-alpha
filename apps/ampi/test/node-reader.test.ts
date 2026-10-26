import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { readerStats } from "../src/node/server.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

test("node reader wire: open, fence, entries, watch, raw and close; a handle belongs to its connection, and disconnect closes it", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { requestId: "reader", cwd: home, model: SIM, place: { workspace: "new", label: "R" } });
		await client.req("thread.submit", { threadId, content: "Read me" });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].preview);

		await assert.rejects(client.req("reader.open", { threadId: `${threadId.split(".")[0]}.999999` }), { code: "not_found" });
		const opened = await client.req("reader.open", { threadId });
		assert.equal(opened.epoch, daemon.runtime.info.startedAt);
		assert.equal(opened.frame.watchRevision, 0);
		const { upper } = await client.req("reader.fence", { handle: opened.handle });
		const page = await client.req("reader.entries", { handle: opened.handle, order: "ascending", limit: 400, maxEntryId: upper });
		assert.equal(page.more, false);
		assert.equal(page.last, upper);
		assert.ok(page.items.some((item: any) => item.record?.kind === "pi.user"), "the history holds the submitted message");
		const raw = await client.req("reader.raw", { handle: opened.handle, id: page.items[0].record.id, offset: 0 });
		assert.equal(raw.done, true);
		assert.equal(JSON.parse(Buffer.from(raw.data, "base64").toString("utf8")).id, page.items[0].record.id);

		// The watch is a topic: every frame replaces the value.
		const watch = client.sub({ kind: "reader", handle: opened.handle });
		await client.req("thread.submit", { threadId, content: "Again" });
		await client.until<any>(watch, (frame) => frame?.watchRevision > 0);

		// Another connection cannot use the handle.
		const other = await TestClient.connect(daemon.socket);
		await assert.rejects(other.req("reader.fence", { handle: opened.handle }), { code: "expired_handle" });
		other.close();

		await client.req("reader.close", { handle: opened.handle });
		await client.until(threads, () => client.ended.has(watch));
		assert.equal(client.ended.get(watch), "closed");
		await assert.rejects(client.req("reader.fence", { handle: opened.handle }), { code: "expired_handle" });
		assert.equal(readerStats(daemon.runtime).handles, 0);

		// Disconnect closes every handle of the connection.
		await client.req("reader.open", { threadId });
		await client.req("reader.open", { threadId });
		assert.equal(readerStats(daemon.runtime).handles, 2);
		client.close();
		const deadline = Date.now() + 5000;
		while (readerStats(daemon.runtime).handles > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(readerStats(daemon.runtime).handles, 0);
	} finally {
		await daemon.stop();
	}
});
