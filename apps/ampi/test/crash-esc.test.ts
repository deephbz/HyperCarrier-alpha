import "./bound.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseThreadKey } from "../src/node/runtime.ts";
import { CrashChild } from "./durable-l2/process.ts";
import { TestClient, tempHome } from "./helpers.ts";

const fixture = new URL("./esc-crash-node.ts", import.meta.url);
const SIM = { provider: "ampi-sim", modelId: "sim-1" };

test("a kill after Esc marks its first compaction: reopen marks both before resume, and neither compaction runs again", async () => {
	const dir = tempHome(), children: CrashChild[] = [];
	let sequence = 0;
	const start = async (mode: string) => {
		const child = new CrashChild(dir, "esc", mode, fixture);
		children.push(child);
		const { socket } = (await child.wait("ready", undefined, 10_000)).value;
		return { child, client: await TestClient.connect(socket) };
	};
	const command = async (child: CrashChild, command: string, args: Record<string, unknown> = {}) => {
		const name = String(++sequence);
		child.child.send({ command, name, ...args });
		return (await child.wait(command, name, 4000)).value;
	};
	const ledger = (mode: string): any[] => {
		const path = join(dir, `${mode}-ledger.jsonl`);
		return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	};
	const until = async (fn: () => Promise<unknown>, message: string) => {
		for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 20))) if (await fn()) return;
		throw new Error(message);
	};
	try {
		const seed = await start("seed");
		const { threadId } = await seed.client.req("thread.create", { cwd: dir, model: SIM, prompt: "/sim long 10" });
		const history = (client: TestClient) => client.req("thread.history", { threadId, before: "1000000", limit: 100 }).then((h: any) => h.entries as any[]);
		const answered = (client: TestClient, count: number) => until(async () => (await history(client)).filter((e) => e.kind === "assistant" && e.stop === "stop").length >= count, `${count} answers`);
		await answered(seed.client, 1);
		for (const i of [2, 3]) {
			await seed.client.req("thread.submit", { threadId, content: "/sim long 10", requestId: `seed-${i}` });
			await answered(seed.client, i);
		}
		const compactions: string[] = [];
		for (const held of [1, 2]) {
			await command(seed.child, "arm", { mode: "uncooperative" });
			compactions.push((await seed.client.req("thread.compact", { threadId })).taskId);
			await until(async () => (await command(seed.child, "held")).held === held, "the summary request is held");
		}
		assert.equal((await seed.client.req("thread.abort", { threadId })).evidence, "stopping", "the fault stops after the first mark");
		const before = await command(seed.child, "snapshot", { threadId });
		assert.equal(before.intents.length, 1, "Esc stored its intent before any mark");
		assert.deepEqual(compactions.map((id) => before.tasks.find((t: any) => t.id === id)?.abortRequested ?? false), [true, false], "only the first is marked");
		seed.client.close();
		seed.child.child.kill("SIGKILL");
		assert.equal((await seed.child.exited).signal, "SIGKILL");

		const reopen = await start("reopen");
		assert.equal((await history(reopen.client)).length > 0, true, "the thread reopens");
		let after: any;
		await until(async () => {
			after = await command(reopen.child, "snapshot", { threadId, taskIds: compactions });
			return after.intents.length === 0 && compactions.every((id) => after.outcomes[id]);
		}, "both compactions settle and the intent is confirmed");
		assert.deepEqual(compactions.map((id) => after.outcomes[id]), ["aborted", "aborted"]);
		assert.equal(after.held, 0, "no captured compaction sent a summary request after the kill");
		const events = ledger("reopen");
		const resume = events.findIndex((e) => e.kind === "scheduler-start" && e.store === parseThreadKey(threadId).storeId);
		const marks = events.slice(0, resume === -1 ? events.length : resume).filter((e) => e.kind === "mark" && String(e.intent).startsWith("esc:"));
		assert.equal(marks.length, 1, "the stored Esc intent is marked before the scheduler starts");
		assert.deepEqual([...marks[0].tasks].sort(), [...compactions].sort(), "the mark reaches both captured compactions");
		assert.deepEqual(events.filter((e) => e.kind === "compact"), [], "recovery starts no compaction");
		assert.equal((await history(reopen.client)).filter((e) => e.kind === "compaction").length, 0, "no summary is written");
		await reopen.client.req("thread.submit", { threadId, content: "/sim long 2", requestId: "after" });
		await answered(reopen.client, 4);
		reopen.client.close();
	} finally {
		for (const child of children) child.cleanup();
		await Promise.all(children.map((child) => child.exited));
		rmSync(dir, { recursive: true, force: true });
	}
});
