import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { getHeapSnapshot } from "node:v8";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { runDaemon } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const BODY = 3 << 20;

/** Strings in a heap snapshot that start with `marker` and are at least `min` bytes. A snapshot holds reachable objects only. */
async function retainedStrings(marker: string, min: number): Promise<number> {
	const chunks: Buffer[] = [];
	for await (const chunk of getHeapSnapshot()) chunks.push(chunk as Buffer);
	const snap = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const fields: string[] = snap.snapshot.meta.node_fields;
	const types: string[] = snap.snapshot.meta.node_types[0];
	const [type, name, size, width] = [fields.indexOf("type"), fields.indexOf("name"), fields.indexOf("self_size"), fields.length];
	let found = 0;
	for (let i = 0; i < snap.nodes.length; i += width)
		if (types[snap.nodes[i + type]] === "string" && snap.nodes[i + size] >= min && String(snap.strings[snap.nodes[i + name]]).startsWith(marker)) found++;
	return found;
}

// D21: the node keeps every thread's row. A row's preview and title are cut from the newest and the first message; a
// plain slice would keep each whole message alive for the node's lifetime.
test("memory: thread rows keep no large message body alive", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 2000 });
	const client = await TestClient.connect(daemon.socket);
	try {
		const threads = client.sub({ kind: "threads" });
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const { threadId } = await client.req("thread.create", { requestId: `memory-${i}`, cwd: home, model: SIM });
			const { store, conversationId } = await daemon.runtime.thread(threadId);
			await store.harness.commit(async (tx) => {
				const at = Number(conversationId) as never;
				await tx.appendEntry(at, { kind: "pi.user", model: [{ role: "user", content: `MEMORY_USER ${i}\n\n${"u".repeat(BODY)}`, timestamp: Date.now() }] as never });
				await tx.appendEntry(at, { kind: "pi.assistant", model: [fauxAssistantMessage(`MEMORY_REPLY ${i}   ${"r".repeat(BODY)}`)] as never });
			}, BACKGROUND_CONTEXT);
			ids.push(threadId);
		}
		const rows = await client.until<any>(threads, (v) => ids.every((id) => v.threads[id]?.preview?.startsWith("MEMORY_REPLY") && v.threads[id].title.startsWith("MEMORY_USER")));
		for (const id of ids) {
			assert.ok(rows.threads[id].preview.length <= 160 && rows.threads[id].title.length <= 80);
			assert.match(rows.threads[id].preview, /^MEMORY_REPLY \d r+$/, "whitespace collapses");
		}
		client.lines.length = 0;
		assert.equal(await retainedStrings("MEMORY_REPLY", BODY), 0, "a row preview pins its reply");
		assert.equal(await retainedStrings("MEMORY_USER", BODY), 0, "a row title pins its first prompt");
	} finally {
		client.close();
		await daemon.stop();
	}
});
