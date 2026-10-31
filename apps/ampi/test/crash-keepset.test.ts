import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { tempHome, writePiSettings } from "./helpers.ts";
import { SIM, startNode, kill } from "./crash-fixtures.ts";

const toolTurn = (name: string) => `${name} turn\n/sim bash printf '${name}-one line %s\\n' 1 2 3 4\n/sim bash printf '${name}-two line %s\\n' 5 6 7 8\n/sim long 1`;

async function answered(client: any, threadId: string, name: string) {
	await client.req("thread.submit", { threadId, content: toolTurn(name) });
	const deadline = Date.now() + 30_000;
	for (;;) {
		const { entries } = await client.req("thread.history", { threadId, before: "1000000", limit: 500 });
		const at = entries.findLastIndex((e: any) => e.kind === "user" && String(e.text).startsWith(`${name} turn`));
		if (at >= 0 && entries.slice(at + 1).some((e: any) => e.kind === "assistant" && e.blocks?.some((b: any) => b.type === "text"))) return;
		assert.ok(Date.now() < deadline, `${name} answered`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("crash: a node killed after the keepset plan installs that plan on restart, with no second planning request", async () => {
	const home = tempHome();
	writePiSettings({ auto_compact: { budget_tokens: 8000 }, compaction: { keepRecentTokens: 200 } });
	let { child, client } = await startNode(home, 50000, { AMPI_FAULT: "after-keepset-plan" });
	const died = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		await client.req("thread.command", { threadId, name: "auto-compact", args: "off" });
		for (const name of ["alpha", "beta"]) {
			await client.req("thread.submit", { threadId, content: toolTurn(name) });
			const deadline = Date.now() + 30_000;
			for (;;) {
				const { entries } = await client.req("thread.history", { threadId, before: "1000000", limit: 500 });
				const at = entries.findLastIndex((e: any) => e.kind === "user" && String(e.text).startsWith(`${name} turn`));
				if (at >= 0 && entries.slice(at + 1).some((e: any) => e.kind === "assistant" && e.blocks?.some((b: any) => b.type === "text"))) break;
				assert.ok(Date.now() < deadline, `${name} answered`);
				await new Promise((r) => setTimeout(r, 50));
			}
		}
		await client.req("thread.compact", { threadId });
		await died; // the node killed itself right after the plan memo was written
		client.close();
		({ child, client } = await startNode(home, 50000));
		const view = client.sub({ kind: "thread", threadId });
		const compacted = await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 30_000);
		const { records } = await client.req("compact.records", { threadId });
		assert.equal(records.length, 1, JSON.stringify(records));
		const record = records[0];
		// The restarted node has captured no request for this conversation, so a second planning request could not run:
		// a keepset record proves the memo served the plan. The first process made the one paid request.
		assert.equal(record.method, "keepset", JSON.stringify(record));
		assert.equal(record.attempts, 2);
		assert.equal(record.planner.requests, 1);
		assert.equal(record.keep.kept.length, 2);
		assert.match(compacted.entries.find((e: any) => e.kind === "compaction").summary, /## Tool results you chose to keep/);
		client.close();
	} finally {
		await kill(child);
	}
});

test("crash: a method change after the paid plan does not bypass it on restart", async () => {
	const home = tempHome();
	writePiSettings({ auto_compact: { budget_tokens: 8000 }, compaction: { keepRecentTokens: 200 } });
	// The fault switches the thread to the native method, as an owner command would, and then kills the node.
	let { child, client } = await startNode(home, 50000, { AMPI_FAULT: "after-keepset-plan-native" });
	const died = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		await client.req("thread.command", { threadId, name: "auto-compact", args: "off" });
		for (const name of ["alpha", "beta"]) await answered(client, threadId, name);
		await client.req("thread.compact", { threadId });
		await died;
		client.close();
		({ child, client } = await startNode(home, 50000));
		const view = client.sub({ kind: "thread", threadId });
		await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 30_000);
		const status = await client.req("compact.records", { threadId });
		assert.equal(status.method, "native", "the owner's change stands for later compactions");
		assert.equal(status.records.length, 1, JSON.stringify(status.records));
		assert.equal(status.records[0].method, "keepset", "the pinned method installs the paid plan");
		assert.equal(status.records[0].planner.requests, 1);
		assert.equal(status.records[0].attempts, 2);
		client.close();
	} finally {
		await kill(child);
	}
});

test("restart: the first keepset compaction after a restart has no captured request and falls back in owner words", async () => {
	const home = tempHome();
	writePiSettings({ auto_compact: { budget_tokens: 8000 }, compaction: { keepRecentTokens: 200 } });
	let { child, client } = await startNode(home, 50000);
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		await client.req("thread.command", { threadId, name: "auto-compact", args: "off" });
		for (const name of ["alpha", "beta"]) await answered(client, threadId, name);
		client.close();
		await kill(child);
		({ child, client } = await startNode(home, 50000));
		await client.req("thread.compact", { threadId });
		const view = client.sub({ kind: "thread", threadId });
		await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 30_000);
		const record = (await client.req("compact.records", { threadId })).records[0];
		assert.equal(record.method, "native-fallback");
		assert.equal(record.error, "no cache reuse: no request captured for this conversation in this process", "the machine reason is unchanged");
		assert.equal(record.planner, undefined, "no planning request was paid");
		const status = await client.req("thread.command", { threadId, name: "auto-compact", args: "status" });
		assert.match(status.body, /summary only \(first compaction after a restart; planner has no cached request yet\)/);
		client.close();
	} finally {
		await kill(child);
	}
});
