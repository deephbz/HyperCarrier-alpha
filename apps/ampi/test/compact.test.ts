import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionTask } from "@earendil-works/pi-durable";
import { CompactDoc } from "../src/plugins/compact.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

test("auto-compact commands persist per-thread controls, preserve safety, and use the compact admission path", async (t) => {
	const home = tempHome();
	let daemon = await runDaemon({ home, simTokensPerSecond: 200, plugins: await hydrate() });
	let client = await TestClient.connect(daemon.socket);
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		const second = await client.req("thread.create", { cwd: home, model: SIM });
		const command = (args: string, extra = {}) => client.req("thread.command", { threadId, name: "auto-compact", args, ...extra });
		await t.test("discovery", async () => {
			const listed = (await client.req("thread.commands", { threadId })).commands.find((c: any) => c.name === "auto-compact");
			assert.ok(listed?.supported);
			assert.match(listed.argsHint, /status.*run.*on.*off.*budget.*threshold/);
		});
		await t.test("status", async () => {
			const ack = await command("status");
			assert.match(ack.body, /Working budget W: 64000/);
			assert.match(ack.body, /Method: keepset/);
			assert.match(ack.body, /Keep cap: 16000 tokens/);
			assert.match(ack.body, /Pi window-edge safety: on \(always\)/);
		});
		for (const [args, field, expected] of [["off", "enabled", false], ["on", "enabled", true], ["budget 8000", "budgetTokens", 8000], ["threshold 65", "thresholdPercent", 65], ["budget default", "budgetTokens", undefined], ["method summary", "method", "summary"], ["method native", "method", "native"], ["method keepset", "method", "keepset"]] as const)
			await t.test(args, async () => {
				await command(args);
				if (args === "off") {
					const status = await command("status");
					assert.match(status.body, /Auto Compact: off/);
					assert.match(status.body, /Pi window-edge safety: on \(always\)/);
				}
				const thread = await daemon.runtime.thread(threadId);
				assert.equal((await thread.store.harness.snapshot(CompactDoc, thread.conversation.id, BACKGROUND_CONTEXT))?.controls?.[field], expected);
				const other = await client.req("compact.records", { threadId: second.threadId });
				assert.equal(other.workingBudget, 64000);
			});
		for (const args of ["execution fg", "execution bg", "preservation all"])
			await t.test(args, async () => assert.match((await command(args)).notice, /not on durable threads\. Durable/));
		await t.test("invalid arguments refuse", async () => {
			for (const args of ["budget 0", "budget NaN", "threshold 0", "threshold 101", "off ignored", "method fork", "method"])
				await assert.rejects(command(args), (e: any) => e.code === "bad_args");
		});
		await t.test("run shares busy refusal and closed gate", async () => {
			const rows = client.sub({ kind: "threads" });
			await client.req("thread.submit", { threadId, content: "/sim long 100" });
			await client.until<any>(rows, v => v.threads[threadId]?.activity !== "idle" && Boolean(v.threads[threadId]));
			await assert.rejects(command("run focus on decisions"), (e: any) => e.code === "busy");
			await client.req("thread.abort", { threadId });
			const ack = await command("run focus on decisions", { key: "compact-once" });
			assert.equal(ack.notice, "Same as /compact: compacting now");
			assert.equal(ack.evidence, "compaction_started");
			assert.deepEqual(await command("run focus on decisions", { key: "compact-once" }), ack);
			await client.req("thread.close", { threadId });
			await assert.rejects(command("run"), (e: any) => e.code === "closed");
		});
		await t.test("controls survive restart", async () => {
			await client.req("thread.command", { threadId: second.threadId, name: "auto-compact", args: "budget 9000", key: "budget" });
			client.close(); await daemon.stop();
			daemon = await runDaemon({ home, plugins: await hydrate() });
			client = await TestClient.connect(daemon.socket);
			assert.equal((await client.req("compact.records", { threadId: second.threadId })).workingBudget, 9000);
		});
	} finally { client.close(); await daemon.stop(); }
});

test("busy auto-compact waits outside admission and refuses to compact after Close", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 200, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	let release = () => {};
	let pending: Promise<any> | undefined;
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim long 100" });
		const rows = client.sub({ kind: "threads" });
		await client.until<any>(rows, v => v.threads[threadId]?.activity === "streaming");
		const getThread = daemon.runtime.thread.bind(daemon.runtime);
		const gate = new Promise<void>(resolve => { release = resolve; });
		let entered = false;
		// Hold the native abort settlement, after its actual cancellation.
		daemon.runtime.thread = async key => {
			const thread = await getThread(key);
			const abort = thread.conversation.abort.bind(thread.conversation);
			thread.conversation.abort = async (...args) => { await abort(...args); entered = true; await gate; };
			return thread;
		};
		pending = client.req("thread.command", { threadId, name: "auto-compact", args: "run", key: "busy", abort: true }).catch(error => error);
		for (const deadline = Date.now() + 3000; !entered && Date.now() < deadline;) await new Promise(r => setTimeout(r, 5));
		assert.ok(entered);
		let closed = false;
		const closing = client.req("thread.close", { threadId }).then(() => { closed = true; });
		for (const deadline = Date.now() + 1000; !closed && Date.now() < deadline;) await new Promise(r => setTimeout(r, 5));
		assert.equal(closed, true, "Close is not queued behind abort settlement");
		await closing; release();
		assert.equal((await pending).code, "closed", "compaction admission rechecks Close after the wait");
		assert.equal((await client.req("compact.records", { threadId })).records.length, 0);
	} finally { release(); await pending; client.close(); await daemon.stop(); }
});

test("per-thread off prevents the HC trigger; on uses the stored budget and threshold", async () => {
	const previous = process.env.AMPI_COMPACT_KEEP_RECENT;
	process.env.AMPI_COMPACT_KEEP_RECENT = "200";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50_000, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		const command = (args: string) => client.req("thread.command", { threadId, name: "auto-compact", args });
		await command("off"); await command("budget 3000"); await command("threshold 50");
		const transcript = client.sub({ kind: "thread", threadId });
		for (let turn = 1; turn <= 2; turn++) {
			await client.req("thread.submit", { threadId, content: `Turn ${turn}\n/sim long 4` });
			await client.until<any>(transcript, v => v.entries.filter((e: any) => e.kind === "assistant").length >= turn && !v.live?.run);
		}
		const state = await client.req("compact.records", { threadId });
		assert.equal(state.workingBudget, 3000);
		assert.equal(state.trigger, 1500);
		assert.equal(state.records.length, 0, "off does not admit a budget compaction");
		await command("on");
		await client.req("thread.submit", { threadId, content: "Third\n/sim long 4" });
		const view = client.sub({ kind: "thread", threadId });
		await client.until<any>(view, v => v.entries.some((e: any) => e.kind === "compaction"));
		assert.ok((await client.req("compact.records", { threadId })).records.some((r: any) => r.reason === "working_budget" && r.trigger.workingBudget === 3000));
	} finally {
		client.close(); await daemon.stop();
		if (previous === undefined) delete process.env.AMPI_COMPACT_KEEP_RECENT; else process.env.AMPI_COMPACT_KEEP_RECENT = previous;
	}
});

/**
 * A turn that grows the context by about 5k tokens of tool output and little prose. AmPi's prompt is about 4.7k
 * tokens, and the conversation record keeps prose, so a summary fits under the trigger only when W leaves room for both.
 */
const GROW = "/sim bash seq 1 4000\n/sim long 1";

test("Auto Compact: crossing W compacts with the HC summary method; a summarizer failure falls back and is recorded", async () => {
	process.env.AMPI_WORKING_BUDGET = "12000";
	process.env.AMPI_COMPACT_KEEP_RECENT = "200";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: await hydrate() });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		await client.req("thread.command", { threadId, name: "auto-compact", args: "method summary" });
		await client.req("thread.submit", { threadId, content: `Draft the migration plan for the orders table\n${GROW}` });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.contextTokens);
		const before = (await client.until<any>(threads, (v) => v.threads[threadId]?.workingBudget)).threads[threadId];
		assert.equal(before.workingBudget, 12000, "W is the configured cap, below 90% of the 64k window");
		await client.req("thread.submit", { threadId, content: `Add the rollback section\n${GROW}` });
		await client.req("thread.submit", { threadId, content: `Now the verification steps\n${GROW}` });
		const view = client.sub({ kind: "thread", threadId });
		const compacted = await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 20_000);
		const entry = compacted.entries.find((e: any) => e.kind === "compaction");
		assert.match(entry.summary, /## Working-state summary/);
		assert.match(entry.summary, /## Conversation record/);
		assert.match(entry.summary, /\[USER\]\nDraft the migration plan for the orders table/);
		const { records, workingBudget } = await client.req("compact.records", { threadId });
		assert.equal(workingBudget, 12000);
		const record = records[0];
		assert.equal(record.method, "hc-summary");
		assert.equal(record.reason, "working_budget");
		assert.ok(record.trigger.tokens > 10_800, JSON.stringify(record));
		assert.equal(record.conversationRecord.fullHistory, true);

		// A summarizer outage: durable's native summary still compacts, and the record names the fallback and why.
		const second = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Short thread /sim compact-error" });
		await client.until<any>(threads, (v) => v.threads[second.threadId]?.activity === "idle" && v.threads[second.threadId]?.preview);
		await client.req("thread.submit", { threadId: second.threadId, content: "one more" });
		await client.until<any>(threads, (v) => v.threads[second.threadId]?.activity === "idle" && v.threads[second.threadId]?.preview?.includes("one more"));
		await client.req("thread.compact", { threadId: second.threadId });
		const secondView = client.sub({ kind: "thread", threadId: second.threadId });
		const fallback = await client.until<any>(secondView, (v) => v.entries.some((e: any) => e.kind === "compaction"));
		assert.match(fallback.entries.find((e: any) => e.kind === "compaction").summary, /native summary/);
		const failed = (await client.req("compact.records", { threadId: second.threadId })).records[0];
		assert.equal(failed.method, "native-fallback");
		assert.match(failed.error, /Simulated summarizer outage/);
		const stored = await daemon.runtime.thread(second.threadId);
		await stored.store.harness.commit(async tx => {
			(await tx.doc(CompactDoc, stored.conversation.id)).records.unshift({ ...failed, at: failed.at - 60_000, error: "older-fallback" });
		}, BACKGROUND_CONTEXT);
		const status = await client.req("thread.command", { threadId: second.threadId, name: "auto-compact", args: "status" });
		assert.match(status.body, /Compaction records: 2/);
		assert.match(status.body, /Latest: \d\d:\d\d · manual · summary only \(Simulated summarizer outage\)/);
		assert.match(status.body, /Planner failing; summary only: 2 fallbacks in a row/);
		assert.doesNotMatch(status.body, /older-fallback|\d{4}-\d\d-\d\dT/);
		assert.deepEqual(client.gaps, [], "every replica applied a contiguous ops stream");
		client.close();
	} finally {
		await daemon.stop();
		delete process.env.AMPI_WORKING_BUDGET;
		delete process.env.AMPI_COMPACT_KEEP_RECENT;
	}
});

/** Counts this thread's live compaction tasks every 10 ms; `most` is the largest count seen. */
async function watchCompactions(daemon: Awaited<ReturnType<typeof runDaemon>>, threadId: string) {
	const { store, conversation } = await daemon.runtime.thread(threadId);
	const live = async () => (await store.harness.inspect(BACKGROUND_CONTEXT)).tasks
		.filter((t) => t.record.kind === CompactionTask.definition.name && Number(t.record.conversationId) === Number(conversation.id)).length;
	let polling = true;
	let most = 0;
	const poll = (async () => { while (polling) { most = Math.max(most, await live()); await new Promise((r) => setTimeout(r, 10)); } })();
	return {
		live,
		/** Waits until no compaction task is live, stops polling, and returns the largest count seen. */
		async settle() {
			while (await live()) await new Promise((r) => setTimeout(r, 20));
			polling = false;
			await poll;
			return most;
		},
		stop() { polling = false; },
	};
}

async function turns(client: TestClient, threadId: string, from: number, to: number, content = "/sim long 4") {
	const transcript = client.sub({ kind: "thread", threadId });
	for (let turn = from; turn <= to; turn++) {
		if (turn > 1) await client.req("thread.submit", { threadId, content: `Turn ${turn}\n${content}` });
		// Compaction hides earlier entries from the view, so read the full history for this turn's answer.
		const marker = turn > 1 ? `Turn ${turn}\n` : "Plan the orders migration";
		const deadline = Date.now() + 60_000;
		for (;;) {
			const { entries } = await client.req("thread.history", { threadId, before: "1000000", limit: 500 });
			const at = entries.findLastIndex((e: any) => e.kind === "user" && JSON.stringify(e).includes(JSON.stringify(marker).slice(1, -1)));
			if (at >= 0 && entries.slice(at + 1).some((e: any) => e.kind === "assistant")) break;
			assert.ok(Date.now() < deadline, `turn ${turn} answered: ${JSON.stringify(entries.slice(-8).map((e: any) => [e.id, e.kind, JSON.stringify(e).slice(0, 80)]))}`);
			await new Promise((r) => setTimeout(r, 50));
		}
		await client.until<any>(transcript, (v) => !v.live?.run, 30_000);
	}
}

// The HC budget trigger is single-flight. Durable's native blocking-threshold and overflow compactions are admitted
// without checking live ones (pi-durable generation.js), a known gap recorded in docs/current/now.md.
test("HC trigger single-flight: responses above W during a slow HC summary start no second HC compaction", async () => {
	process.env.AMPI_WORKING_BUDGET = "12000";
	process.env.AMPI_COMPACT_KEEP_RECENT = "200";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	let watch: Awaited<ReturnType<typeof watchCompactions>> | undefined;
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: `Plan the orders migration\n/sim compact-slow 3000\n${GROW}` });
		// The summary method: the large outputs that grow the context would be over the keepset cap.
		await client.req("thread.command", { threadId, name: "auto-compact", args: "method summary" });
		watch = await watchCompactions(daemon, threadId);
		// Turn 2 crosses the trigger and starts the slow summary; turns 3 to 6 each answer above W while it runs. They stay short,
		// so the summary still fits beside them when it installs.
		await turns(client, threadId, 1, 2, GROW);
		await turns(client, threadId, 3, 6, "/sim long 1");
		const view = await client.until<any>(client.sub({ kind: "thread", threadId }), (v) => v.entries.some((e: any) => e.kind === "compaction"), 20_000);
		assert.equal(await watch.settle(), 1, "at most one HC compaction in flight");
		const { records } = await client.req("compact.records", { threadId });
		assert.ok(records.length >= 1);
		assert.deepEqual(records.map((r: any) => r.reason), records.map(() => "working_budget"), "an in-flight budget compaction keeps its label");
		assert.equal(new Set(records.map((r: any) => r.firstKept)).size, records.length, "no range is summarized twice");
		const summary = view.entries.find((e: any) => e.kind === "compaction").summary;
		assert.ok(summary.startsWith("## Working-state summary"), `the row shows the HC summary as written, without durable's model wrapper: ${JSON.stringify(records)}`);
	} finally {
		watch?.stop();
		client.close(); await daemon.stop();
		delete process.env.AMPI_WORKING_BUDGET;
		delete process.env.AMPI_COMPACT_KEEP_RECENT;
	}
});

test("HC trigger single-flight releases after a failed compaction task: the next crossing compacts again", async () => {
	process.env.AMPI_WORKING_BUDGET = "2500";
	process.env.AMPI_COMPACT_KEEP_RECENT = "200";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	let watch: Awaited<ReturnType<typeof watchCompactions>> | undefined;
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Plan the orders migration\n/sim compact-fail\n/sim compact-slow 500\n/sim long 4" });
		watch = await watchCompactions(daemon, threadId);
		await turns(client, threadId, 1, 3);
		// The first compaction fails (both summarizers); the guard holds while it runs, then releases.
		while ((await client.req("compact.records", { threadId })).records.length < 1) await new Promise((r) => setTimeout(r, 20));
		while (await watch.live()) await new Promise((r) => setTimeout(r, 20));
		await turns(client, threadId, 4, 4);
		const deadline = Date.now() + 20_000;
		while ((await client.req("compact.records", { threadId })).records.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
		assert.equal(await watch.settle(), 1, "one in flight at a time");
		const { records } = await client.req("compact.records", { threadId });
		assert.ok(records.length >= 2, `a crossing after the failure compacts again: ${JSON.stringify(records)}`);
		assert.ok(records.every((r: any) => r.method === "native-fallback" && /outage/.test(r.error)), JSON.stringify(records));
		const history = await client.req("thread.history", { threadId, before: "1000000", limit: 500 });
		assert.equal(history.entries.filter((e: any) => e.kind === "compaction").length, 0, "no summary was placed");
	} finally {
		watch?.stop();
		client.close(); await daemon.stop();
		delete process.env.AMPI_WORKING_BUDGET;
		delete process.env.AMPI_COMPACT_KEEP_RECENT;
	}
});

test("HC trigger single-flight releases after stale placement; an owner's manual compaction still overlaps (current behavior)", async () => {
	process.env.AMPI_WORKING_BUDGET = "2500";
	process.env.AMPI_COMPACT_KEEP_RECENT = "200";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	let watch: Awaited<ReturnType<typeof watchCompactions>> | undefined;
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Plan the orders migration\n/sim compact-slow 4000\n/sim long 4" });
		watch = await watchCompactions(daemon, threadId);
		// Turn 3 starts the slow HC summary. After turn 4, a manual compaction cuts later and is placed first, so the
		// HC summary, whose cut now lies before the context start, settles stale.
		await turns(client, threadId, 1, 4);
		await client.req("thread.compact", { threadId });
		assert.equal(await watch.settle(), 2, "current behavior: a manual compaction does not wait for the HC one");
		const history = async () => (await client.req("thread.history", { threadId, before: "1000000", limit: 500 })).entries;
		assert.deepEqual((await history()).filter((e: any) => e.kind === "compaction").map((e: any) => e.reason), ["manual"], "two compactions, one placed: the HC summary settled stale");
		const before = (await client.req("compact.records", { threadId })).records;
		assert.deepEqual(before.map((r: any) => r.reason).sort(), ["manual", "working_budget"]);
		// After the stale settlement, a new turn above W starts an HC compaction again. (Later turns would also cross
		// durable's background threshold, whose fixed prompt counts, and race it.)
		await turns(client, threadId, 5, 5, "/sim long 6");
		const deadline = Date.now() + 20_000;
		while ((await client.req("compact.records", { threadId })).records.length <= before.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
		assert.equal((await client.req("compact.records", { threadId })).records.at(-1)?.reason, "working_budget", `the guard released: ${JSON.stringify((await client.req("compact.records", { threadId })).records.map((r: any) => [r.reason, r.firstKept, r.at % 100000]))}`);
	} finally {
		watch?.stop();
		client.close(); await daemon.stop();
		delete process.env.AMPI_WORKING_BUDGET;
		delete process.env.AMPI_COMPACT_KEEP_RECENT;
	}
});

/** Two tool rounds per turn: their outputs are what the keepset plan keeps or drops. */
const toolTurn = (name: string) => `${name} turn\n/sim bash printf '${name}-one line %s\\n' 1 2 3 4\n/sim bash printf '${name}-two line %s\\n' 5 6 7 8\n/sim long 1`;

/** Waits until the turn whose user text starts with `marker` has its final answer. */
async function answered(client: TestClient, threadId: string, marker: string) {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const { entries } = await client.req("thread.history", { threadId, before: "1000000", limit: 500 });
		const at = entries.findLastIndex((e: any) => e.kind === "user" && String(e.text).startsWith(marker));
		if (at >= 0 && entries.slice(at + 1).some((e: any) => e.kind === "assistant" && e.blocks?.some((b: any) => b.type === "text"))) return;
		assert.ok(Date.now() < deadline, `${marker} answered`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("keepset: the plan keeps the chosen outputs verbatim; a rejected plan falls back to the native summary and is recorded", async () => {
	process.env.AMPI_WORKING_BUDGET = "8000";
	process.env.AMPI_COMPACT_KEEP_RECENT = "200";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	try {
		// The budget trigger is off while the turns run, so the replaced range holds all four outputs.
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		await client.req("thread.command", { threadId, name: "auto-compact", args: "off" });
		for (const name of ["alpha", "beta"]) {
			await client.req("thread.submit", { threadId, content: toolTurn(name) });
			await answered(client, threadId, `${name} turn`);
		}
		await client.req("thread.compact", { threadId });
		const view = client.sub({ kind: "thread", threadId });
		const compacted = await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 30_000);
		const summary: string = compacted.entries.find((e: any) => e.kind === "compaction").summary;
		const record = (await client.req("compact.records", { threadId })).records[0];
		assert.equal(record.method, "keepset", JSON.stringify(record));
		assert.equal(record.attempts, 1);
		assert.ok(record.taskId);
		assert.equal(compacted.entries.find((e: any) => e.kind === "compaction").byTaskId, record.taskId, "the row joins its record by task");
		// T7: the active context starts at the compaction row, so the web's "active context starts below" marker sits above it.
		assert.equal(compacted.entries[0].kind, "compaction", JSON.stringify(compacted.entries.map((e: any) => e.kind)));
		assert.equal(compacted.hiddenBefore, true);
		// The sim plan keeps the two newest outputs of the replaced range; every other output is dropped and indexed.
		assert.equal(record.keep.kept.length, 2, JSON.stringify(record.keep));
		assert.equal(record.keep.cap, 2000, "min(20000, W/4)");
		assert.equal(summary.match(/^### t\d+ · bash/gm)?.length, 2, "two kept outputs in the summary");
		assert.ok(record.keep.droppedCount >= 1, JSON.stringify(record.keep));
		assert.equal(record.keep.dropped.length, record.keep.droppedCount);
		const order = ["## Working-state summary", "## Tool results you chose to keep", "## Conversation record", "## Dropped tool results"].map((h) => summary.indexOf(h));
		assert.deepEqual([...order].sort((a, b) => a - b), order, `sections in order: ${order}`);
		assert.ok(order.every((at) => at >= 0));
		assert.match(summary, /simulated keepset plan/);
		const { entries } = await client.req("thread.history", { threadId, before: "1000000", limit: 500 });
		for (const kept of record.keep.kept) {
			const result = entries.find((e: any) => e.id === kept.entryId);
			assert.equal(result?.kind, "tool-result", JSON.stringify(kept));
			assert.ok(result.text.length > 10 && summary.includes(`\n${result.text}\n\`\`\``), `kept ${kept.label} is byte-equal to its history entry: ${result.text.slice(0, 80)}`);
		}
		for (const dropped of record.keep.dropped) assert.ok(entries.some((e: any) => e.id === dropped.entryId), `dropped ${dropped.label} links to history`);
		assert.ok(record.planner.requests >= 1);
		assert.match(record.planner.cache, /cache/);
		const status = await client.req("thread.command", { threadId, name: "auto-compact", args: "status" });
		assert.match(status.body, /Latest: .* · keepset · \d+ entries replaced · 2 outputs kept \(\d+ of 2\.0k\) · \d+ dropped\n/);
		assert.match(status.body, /\nPlanner: planner ampi-sim\/sim-1 · 1 request · /);

		// A plan that names an unknown output is rejected: durable's native summary compacts and the record says why.
		const bad = await client.req("thread.create", { cwd: home, model: SIM, prompt: `${toolTurn("delta")}\n/sim keep-unknown` });
		await answered(client, bad.threadId, "delta turn");
		await client.req("thread.compact", { threadId: bad.threadId });
		const badView = client.sub({ kind: "thread", threadId: bad.threadId });
		const fellBack = await client.until<any>(badView, (v) => v.entries.some((e: any) => e.kind === "compaction"), 30_000);
		assert.match(fellBack.entries.find((e: any) => e.kind === "compaction").summary, /native summary/);
		const rejected = (await client.req("compact.records", { threadId: bad.threadId })).records[0];
		assert.equal(rejected.method, "native-fallback");
		assert.match(rejected.planRejected, /keep named an unknown entry \(t999\)/);
		assert.equal(rejected.planner.requests, 1, "the paid planning request is in the record");
		const badStatus = await client.req("thread.command", { threadId: bad.threadId, name: "auto-compact", args: "status" });
		assert.match(badStatus.body, /summary only \(plan rejected: keep named an unknown entry \(t999\)\)/);
	} finally {
		client.close();
		await daemon.stop();
		delete process.env.AMPI_WORKING_BUDGET;
		delete process.env.AMPI_COMPACT_KEEP_RECENT;
	}
});

test("keepset: a planner summary too large for the compaction trigger falls back with the fit reason", async () => {
	// The trigger (90% of W) leaves room for AmPi's prompt and a normal plan, not for the 10k-token one.
	process.env.AMPI_WORKING_BUDGET = "14000";
	process.env.AMPI_COMPACT_KEEP_RECENT = "200";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		await client.req("thread.command", { threadId, name: "auto-compact", args: "off" });
		await client.req("thread.submit", { threadId, content: `${toolTurn("huge")}\n/sim plan-huge` });
		await answered(client, threadId, "huge turn");
		await client.req("thread.compact", { threadId });
		const view = client.sub({ kind: "thread", threadId });
		await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 30_000);
		const record = (await client.req("compact.records", { threadId })).records.at(-1);
		assert.equal(record.method, "native-fallback", JSON.stringify(record));
		const fit = /^the summary does not fit: summary (\d+) \+ kept tail \d+ \+ prompt (\d+) = \d+ tokens, over the \d+-token compaction trigger$/.exec(record.planRejected);
		assert.ok(fit && Number(fit[1]) >= 10_000, `the 10k-token plan is what does not fit: ${record.planRejected}`);
		assert.ok(Number(fit[2]) > 1000, "AmPi's real prompt counts");
		assert.equal(record.planner.requests, 1);
		const status = await client.req("thread.command", { threadId, name: "auto-compact", args: "status" });
		assert.match(status.body, /· summary only \(plan too large for the window\)\n/);
		assert.match(status.body, /\nNote: the summary does not fit: summary \d+/);
	} finally {
		client.close();
		await daemon.stop();
		delete process.env.AMPI_WORKING_BUDGET;
		delete process.env.AMPI_COMPACT_KEEP_RECENT;
	}
});
