import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

test("a thread runs a tool turn and streams its view to a client", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 5000 });
	try {
		const client = await TestClient.connect(daemon.socket);
		assert.equal(client.hello?.protocol, "ampi/1");
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim bash echo hello-from-tool" });
		const view = client.sub({ kind: "thread", threadId });
		const done = await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "assistant" && e.stop === "stop"));
		const result = done.entries.find((e: any) => e.kind === "tool-result");
		assert.equal(result.name, "bash");
		assert.match(result.text, /hello-from-tool/);
		const list = await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.preview !== undefined);
		assert.equal(list.threads[threadId].title, "/sim bash echo hello-from-tool");
		assert.deepEqual(client.gaps, [], "every replica applied a contiguous ops stream");
		client.close();
	} finally {
		await daemon.stop();
	}
});
