import "./bound.ts";
// The durable catalog stays current (a generation resolves its model through the gated models, which re-read a
// changed models.json first), and `thread.reload` re-reads in place, reports, and interrupts no thread.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";

/** An OpenAI chat-completions endpoint that streams one fixed reply and counts its requests. */
async function fakeCompletions(text: string) {
	let requests = 0;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			requests++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (choice: object, extra: object = {}) =>
				res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m1", choices: [choice], ...extra })}\n\n`);
			chunk({ index: 0, delta: { role: "assistant", content: text }, finish_reason: null });
			chunk({ index: 0, delta: {}, finish_reason: "stop" }, { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests: () => requests, close: () => server.close() };
}

const fakeco = (baseUrl: string, ids: string[], extra: object = {}) => ({ baseUrl, api: "openai-completions", apiKey: "literal-key", models: ids.map((id) => ({ id })), ...extra });

function agentDirOf(home: string): string {
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fakeco", defaultModel: "m1" }));
	return agentDir;
}

const replies = (view: any) => (view.entries ?? []).filter((e: any) => e.kind === "assistant" && e.stop);

test("node reload: the first generation after a models.json edit uses the new entry, with no models.list", async () => {
	const [before, after] = [await fakeCompletions("from A"), await fakeCompletions("from B")];
	const home = tempHome();
	const agentDir = agentDirOf(home);
	const modelsJson = join(agentDir, "models.json");
	writeFileSync(modelsJson, JSON.stringify({ providers: { fakeco: fakeco(before.url, ["m1"]) } }));
	const daemon = await runDaemon({ home, agentDir, testProviders: ["fakeco"] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const { threadId } = await client.req("thread.create", { requestId: "d8-1", cwd: home, place: { workspace: "new", label: "D8" }, prompt: "hi" });
		const view = client.sub({ kind: "thread", threadId });
		await client.until<any>(view, (v) => replies(v).length === 1);
		assert.deepEqual([before.requests(), after.requests()], [1, 0]);
		// A sync moves the provider. The size changes too, so the stamp sees the edit.
		writeFileSync(modelsJson, JSON.stringify({ providers: { fakeco: fakeco(after.url, ["m1"], { headers: { "X-Generation": "second" } }) } }));
		await client.req("thread.submit", { threadId, content: "again" });
		const second = replies(await client.until<any>(view, (v) => replies(v).length === 2))[1];
		assert.equal(second.error, undefined);
		assert.equal(second.blocks.map((b: any) => b.text).join(""), "from B", "the same generation that resolved the model used the edited baseUrl");
		assert.deepEqual([before.requests(), after.requests()], [1, 1]);
		client.close();
	} finally {
		await daemon.stop();
		before.close();
		after.close();
	}
});

test("node reload: thread.reload re-reads an edit the stamp misses, warns, keeps the catalog on a parse error, and stops no sibling", async () => {
	const fake = await fakeCompletions("hello");
	const home = tempHome();
	const agentDir = agentDirOf(home);
	const modelsJson = join(agentDir, "models.json");
	const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
	const write = (content: string) => {
		writeFileSync(modelsJson, content);
		utimesSync(modelsJson, pinned, pinned);
	};
	write(JSON.stringify({ providers: { fakeco: fakeco(fake.url, ["m1", "m2"]) } }));
	const daemon = await runDaemon({ home, agentDir, testProviders: ["fakeco"], simTokensPerSecond: 50000 });
	const release = join(home, "release-sibling");
	try {
		const client = await TestClient.connect(daemon.socket);
		const listed = async () => (await client.req<any[]>("models.list", {})).filter((m) => m.provider === "fakeco").map((m) => m.id).sort();
		const { threadId } = await client.req("thread.create", { requestId: "reload-1", cwd: home, place: { workspace: "new", label: "Target" }, prompt: "hi" });
		const view = client.sub({ kind: "thread", threadId });
		await client.until<any>(view, (v) => replies(v).length === 1);
		// A sibling holds mid-run in a tool call until the test releases it.
		const sibling = (await client.req("thread.create", { requestId: "reload-2", cwd: home, place: { workspace: "new", label: "Sibling" }, model: { provider: "ampi-sim", modelId: "sim-1" }, prompt: `/sim hold ${release}` })).threadId;
		const threads = client.sub({ kind: "threads" });
		await client.until<any>(threads, (v) => v.threads?.[sibling]?.activity && v.threads[sibling].activity !== "idle");

		// The same size and mtime: the stamp misses this edit, so only a forced re-read sees it.
		write(JSON.stringify({ providers: { fakeco: fakeco(fake.url, ["m1", "m3"]) } }));
		assert.deepEqual(await listed(), ["m1", "m2"], "a stamp-gated list keeps the old catalog");
		const report = await client.req("thread.reload", { threadId });
		assert.deepEqual([report.threadId, report.reloaded, report.warnings], [threadId, ["models", "settings", "resources"], []]);
		assert.ok(report.providers > 1, `the catalog has the providers: ${report.providers}`);
		assert.deepEqual(await listed(), ["m1", "m3"]);

		// The thread's model left the catalog: the reload warns.
		write(JSON.stringify({ providers: { fakeco: fakeco(fake.url, ["m3"]) } }));
		const missing = await client.req("thread.reload", { threadId });
		assert.ok(missing.warnings.some((w: string) => w.includes("fakeco/m1 is not in the catalog")), JSON.stringify(missing.warnings));

		// A file caught mid-write keeps the previous catalog.
		write('{"providers": {"fakeco"');
		const broken = await client.req("thread.reload", { threadId });
		assert.ok(broken.warnings.some((w: string) => w.includes("did not parse")), JSON.stringify(broken.warnings));
		assert.deepEqual(await listed(), ["m3"]);

		await assert.rejects(client.req("thread.reload", { threadId: `${threadId.slice(0, threadId.lastIndexOf("."))}.9999` }), { code: "not_found" });

		// The sibling ran through every reload: it is still in its run, and it ends without an abort or an error.
		assert.notEqual(client.values.get(threads) && (client.values.get(threads) as any).threads[sibling].activity, "idle");
		writeFileSync(release, "");
		const siblingView = client.sub({ kind: "thread", threadId: sibling });
		const done = await client.until<any>(siblingView, (v) => replies(v).some((e: any) => e.stopReason !== "toolUse" && !e.blocks?.some((b: any) => b.type === "toolCall")) || replies(v).some((e: any) => e.error));
		for (const reply of replies(done)) assert.equal(reply.error, undefined, JSON.stringify(reply));
		client.close();
	} finally {
		writeFileSync(release, "");
		await daemon.stop();
		fake.close();
	}
});
