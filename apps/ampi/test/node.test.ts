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

test("an archive intent survives a node crash before stop and resumes safely on unarchive", async () => {
	const home = tempHome();
	const first = await runDaemon({ home, simTokensPerSecond: 5000 });
	const client = await TestClient.connect(first.socket);
	const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim say before-crash" });
	const topic = client.sub({ kind: "thread", threadId });
	await client.until<any>(topic, (v) => v.entries.some((e: any) => e.kind === "assistant" && e.stop === "stop"));
	process.env.AMPI_FAULT = "archive-intent-only";
	try {
		await client.req("thread.archive", { threadId, archived: true });
	} finally {
		delete process.env.AMPI_FAULT;
		client.close();
		await first.stop();
	}
	const restarted = await runDaemon({ home, simTokensPerSecond: 5000 });
	try {
		const after = await TestClient.connect(restarted.socket);
		const threads = after.sub({ kind: "threads" });
		const list = await after.until<any>(threads, (v) => v.threads[threadId]?.archived === true);
		assert.equal(list.threads[threadId].activity, "idle");
		await after.req("thread.archive", { threadId, archived: false });
		const response = await after.req("thread.submit", { threadId, content: "/sim say after-crash", requestId: "after-crash" });
		assert.ok(["started", "admitted"].includes(response.evidence));
		after.close();
	} finally {
		await restarted.stop();
	}
});

test("archive stops a thread and a new message unarchives it with its history", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 5000 });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim say archive-history" });
		const topic = client.sub({ kind: "thread", threadId });
		await client.until<any>(topic, (v) => v.entries.some((e: any) => e.kind === "assistant" && e.stop === "stop"));
		await client.req("thread.archive", { threadId, archived: true });
		const archived = await client.until<any>(threads, (v) => v.threads[threadId]?.archived === true);
		assert.equal(archived.threads[threadId].activity, "idle");
		await assert.rejects(client.req("thread.compact", { threadId }), /is archived/);
		const response = await client.req("thread.submit", { threadId, content: "/sim say continued", requestId: "archive-resume" });
		assert.equal(response.evidence, "started");
		const continued = await client.until<any>(topic, (v) => v.entries.some((e: any) => e.kind === "assistant" && e.stop === "stop" && JSON.stringify(e).includes("continued")));
		assert.ok(continued.entries.some((e: any) => JSON.stringify(e).includes("archive-history")), "the full prior transcript remains readable");
		const row = await client.until<any>(threads, (v) => v.threads[threadId]?.archived !== true && v.threads[threadId]?.activity === "idle");
		assert.equal(row.threads[threadId].archived, undefined);
		client.close();
	} finally {
		await daemon.stop();
	}
});
