import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RarebitDoc } from "@hypercarrier/rarebit-durable";
import { CommandsDoc } from "../src/node/commands.ts";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { rarebitPlugin } from "../src/plugins/rarebit.ts";
import type { Store } from "../src/node/runtime.ts";
import { TestClient, tempHome, writePiSettings } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

test("Summary retirement scans each conversation once; reopen skips settled and empty conversations without spend", async () => {
	const home = tempHome();
	let daemon = await runDaemon({ home, plugins: [] });
	let client = await TestClient.connect(daemon.socket);
	let calls = 0;
	const attach = async (store: Store) => {
		const snapshot = store.harness.snapshot.bind(store.harness);
		let reads = 0;
		store.harness.snapshot = (async (...args: Parameters<typeof snapshot>) => {
			const doc: unknown = args[0];
			if (doc === RarebitDoc || doc === CommandsDoc) reads++;
			return snapshot(...args);
		}) as typeof snapshot;
		daemon.runtime.models.completeSimple = async () => { calls++; throw new Error("retirement must not spend"); };
		try { await rarebitPlugin().attach!(store, daemon.runtime); }
		finally { store.harness.snapshot = snapshot; }
		return reads;
	};
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		const thread = await daemon.runtime.thread(threadId);
		const anchor = await thread.conversation.commit(tx => tx.appendEntry(thread.conversation.id, { kind: "test.anchor", data: {} }), BACKGROUND_CONTEXT);
		await thread.conversation.fork(anchor.id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		await thread.store.harness.commit(async tx => {
			const doc = await tx.doc(RarebitDoc, thread.conversation.id);
			doc.running = { boundary: "manual", coveredEntryId: "1", since: 1, boot: "old" };
			doc.commands = { pending: { action: "summarize", boot: "old", at: 1, coveredEntryId: "1" } };
			(await tx.doc(CommandsDoc, thread.conversation.id)).keys.pending = { name: "rarebit", args: "summarize", at: 1, after: null };
		}, BACKGROUND_CONTEXT);
		assert.equal(await attach(thread.store), 4, "first pass reads the pending conversation and the empty fork");
		const settled = await thread.store.harness.snapshot(RarebitDoc, thread.conversation.id, BACKGROUND_CONTEXT);
		assert.match(settled?.commands?.pending?.result?.notice ?? "", /retired/i);
		assert.equal(settled?.running, undefined);
		assert.match((await thread.store.harness.snapshot(CommandsDoc, thread.conversation.id, BACKGROUND_CONTEXT))?.keys.pending?.reply?.notice ?? "", /retired/i);
		client.close(); await daemon.stop();
		daemon = await runDaemon({ home, plugins: [] });
		client = await TestClient.connect(daemon.socket);
		const reopened = await daemon.runtime.thread(threadId);
		assert.equal(await attach(reopened.store), 0, "a later boot skips both settled and empty conversations");
		assert.deepEqual(await reopened.store.harness.snapshot(RarebitDoc, reopened.conversation.id, BACKGROUND_CONTEXT), settled, "a later boot does not rewrite the retirement receipt");
		await reopened.conversation.fork(anchor.id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		assert.equal(await attach(reopened.store), 2, "a new conversation gets its own single pass");
		assert.equal(await attach(reopened.store), 0);
		assert.equal(calls, 0);
	} finally { client.close(); await daemon.stop(); }
});

test("retired Summary intents settle on reopen without spend; old receipts remain but readers ignore them", async () => {
	const home = tempHome();
	let daemon = await runDaemon({ home, simTokensPerSecond: 50_000, plugins: await hydrate() });
	let client = await TestClient.connect(daemon.socket);
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Keep the original evidence" });
		const view = client.sub({ kind: "rarebit", threadId });
		await client.until<any>(view, v => v.state.title);
		const thread = await daemon.runtime.thread(threadId);
		const old = { status: "summarized" as const, sessionStatus: "needs_attention" as const, statusReason: "input", summary: "LEGACY_SUMMARY_ONLY", boundary: "manual" as const, coveredEntryId: "1", manifestHash: "legacy", coverage: { totalMessageCount: 2, includedMessageCount: 2, omittedMessageCount: 0, complete: true }, model: "synthetic/old", promptVersion: "old", at: 1 };
		await thread.store.harness.commit(async tx => {
			const doc = await tx.doc(RarebitDoc, thread.conversation.id);
			doc.summary = old; doc.attempt = old;
			doc.running = { boundary: "manual", coveredEntryId: "1", since: 1, boot: "old" };
			doc.commands = { pending: { action: "summarize", boot: "old", at: 1, coveredEntryId: "1" } };
			(await tx.doc(CommandsDoc, thread.conversation.id)).keys.pending = { name: "rarebit", args: "summarize", at: 1, after: null };
		}, BACKGROUND_CONTEXT);
		client.close(); await daemon.stop();
		let calls = 0;
		daemon = await runDaemon({ home, simTokensPerSecond: 50_000, plugins: [{ extensions: [], attach(_store, runtime) { runtime.models.completeSimple = async () => { calls++; throw new Error("unexpected retired Summary spend"); }; } }, ...await hydrate()] });
		client = await TestClient.connect(daemon.socket);
		const reopened = await daemon.runtime.thread(threadId);
		const doc = await reopened.store.harness.snapshot(RarebitDoc, reopened.conversation.id, BACKGROUND_CONTEXT);
		assert.match(doc?.commands?.pending?.result?.notice ?? "", /retired/i);
		assert.equal(doc?.running, undefined);
		assert.match(doc?.retiredSummary?.notice ?? "", /retired/i);
		assert.deepEqual(doc?.summary, old);
		assert.deepEqual(doc?.attempt, old);
		const ack = await client.req("thread.command", { threadId, name: "rarebit", args: "summarize", key: "pending" });
		assert.match(ack.notice, /retired/i);
		for (const action of ["summarize", "recap"]) await assert.rejects(client.req("thread.command", { threadId, name: "rarebit", args: action, key: `fresh-${action}` }), (e: any) => e.code === "bad_args");
		const current = await client.until<any>(client.sub({ kind: "rarebit", threadId }), v => v.count > 0);
		assert.doesNotMatch(JSON.stringify(current), /LEGACY_SUMMARY_ONLY|needs_attention/);
		const index = await client.until<any>(client.sub({ kind: "threads" }), v => v.threads[threadId]);
		assert.equal(index.threads[threadId].rarebit, undefined);
		assert.equal(calls, 0);
	} finally { client.close(); await daemon.stop(); }
});

test("Rarebit commands read receipts, derive once per key, and keep panel replay read-only", async (t) => {
	const home = tempHome();
	let daemon = await runDaemon({ home, simTokensPerSecond: 50_000, plugins: await hydrate() });
	let client = await TestClient.connect(daemon.socket);
	let calls = 0;
	const track = () => {
		const complete = daemon.runtime.models.completeSimple.bind(daemon.runtime.models);
		daemon.runtime.models.completeSimple = (...args) => { calls++; return complete(...args); };
	};
	track();
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM });
		// Let the initial automatic jobs settle before measuring manual command spend.
		await client.req("thread.submit", { threadId, content: "Implement the receipt audit" });
		const rarebit = client.sub({ kind: "rarebit", threadId });
		await client.until<any>(rarebit, v => v.state.title);
		assert.equal(calls, 1, "a settled run derives only a Title");
		const command = (args: string, key = args) => client.req("thread.command", { threadId, name: "rarebit", args, key });
		await t.test("discovery", async () => assert.ok((await client.req("thread.commands", { threadId })).commands.find((c: any) => c.name === "rarebit")?.supported));
		await t.test("status", async () => {
			const before = calls;
			const { body } = await command("status");
			assert.doesNotMatch(body, /Summary|Policy/);
			assert.doesNotMatch(body, /[{}]/);
			assert.match(body, /Title: derived .+ · \d\d:\d\d/);
			assert.equal(calls, before);
		});
		for (const option of ["title"]) await t.test(option, async () => {
			const before = calls;
			const ack = await command(option);
			assert.match(ack.notice, /Title/);
			assert.equal(calls, before + 1);
			assert.deepEqual(await command(option), ack);
			assert.equal(calls, before + 1);
			const thread = await daemon.runtime.thread(threadId);
			const state = await thread.store.harness.snapshot(RarebitDoc, thread.conversation.id, BACKGROUND_CONTEXT);
			assert.ok(state?.title?.title);
			// Lose the command reply after the plugin receipt committed.
			await thread.store.harness.commit(async tx => { delete (await tx.doc(CommandsDoc, thread.conversation.id)).keys[option]!.reply; }, BACKGROUND_CONTEXT);
			assert.deepEqual(await command(option), ack);
			assert.equal(calls, before + 1, "receipt-backed replay does not derive again");
		});

		for (const option of ["view", "menu"]) await t.test(option, async () => {
			const before = calls;
			assert.equal((await command(option)).panel, "rarebit");
			assert.equal((await command(option)).panel, undefined);
			assert.equal(calls, before);
		});
		await t.test("help", async () => assert.match((await command("help")).body, /status.*title.*view.*menu.*\nPi pane only:/s));
		for (const option of ["recall latest", "settings", "fork", "btw", "config", "auto-title"]) await t.test(option, async () => {
			const before = calls;
			const ack = await command(option);
			if (option.startsWith("recall")) assert.equal(ack.notice, "Durable has no recall yet; use Find.");
			else assert.match(ack.notice, /not on durable threads\. Durable/);
			assert.equal(calls, before);
		});
		await t.test("restart replay and closed refusal", async () => {
			client.close(); await daemon.stop();
			daemon = await runDaemon({ home, plugins: await hydrate() });
			client = await TestClient.connect(daemon.socket);
			track();
			const before = calls;
			assert.equal((await command("view")).panel, undefined);
			await command("title");
			assert.equal(calls, before);
			await client.req("thread.close", { threadId });
			await assert.rejects(command("title", "closed"), (e: any) => e.code === "closed");
		});
	} finally { client.close(); await daemon.stop(); }
});

test("pending command retries share a result; later eviction cannot resurrect the key", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50_000, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	let release = () => {};
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Implement queued receipts" });
		const view = client.sub({ kind: "rarebit", threadId });
		await client.until<any>(view, v => v.state.title);
		const complete = daemon.runtime.models.completeSimple.bind(daemon.runtime.models);
		const gate = new Promise<void>(resolve => { release = resolve; });
		let calls = 0;
		daemon.runtime.models.completeSimple = async (...args) => { calls++; await gate; return complete(...args); };
		const command = (args: string, key: string) => client.req("thread.command", { threadId, name: "rarebit", args, key });
		const first = command("title", "pending");
		const retry = command("title", "pending");
		await assert.rejects(command("status", "pending"), (e: any) => e.code === "key_conflict");
		// Reads run while the provider is held. They evict the pending full receipt.
		for (let i = 0; i < 201; i++) await command("status", `read-${i}`);
		await assert.rejects(command("title", "pending"), (e: any) => e.code === "command_expired");
		release();
		const [a, b] = await Promise.all([first, retry]);
		assert.deepEqual(a, b);
		assert.match(a.notice, /Title derived/);
		assert.equal(calls, 1);
		await assert.rejects(command("title", "pending"), (e: any) => e.code === "command_expired");
		assert.equal(calls, 1, "late settlement never grants the retired key authority again");
	} finally { release(); client.close(); await daemon.stop(); }
});

test("evicted command keys never become fresh spend authority, including after restart", async () => {
	const home = tempHome();
	let daemon = await runDaemon({ home, simTokensPerSecond: 500_000, plugins: await hydrate() });
	let client = await TestClient.connect(daemon.socket);
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Implement durable receipts" });
		const view = client.sub({ kind: "rarebit", threadId });
		await client.until<any>(view, v => v.state.title);
		let calls = 0;
		const track = () => {
			const complete = daemon.runtime.models.completeSimple.bind(daemon.runtime.models);
			daemon.runtime.models.completeSimple = (...args) => { calls++; return complete(...args); };
		};
		track();
		const command = (name: string, args: string, key: string) => client.req("thread.command", { threadId, name, args, key });
		const first = [["rarebit", "title", "title-A"], ["compact", "", "compact-A"], ["auto-compact", "run", "auto-A"]];
		for (const [name, args, key] of first) await command(name!, args!, key!);
		for (let i = 0; i < 202; i++) await command("rarebit", "title", `later-${i}`);
		const thread = await daemon.runtime.thread(threadId);
		const commands = await thread.store.harness.snapshot(CommandsDoc, thread.conversation.id, BACKGROUND_CONTEXT);
		const rarebit = await thread.store.harness.snapshot(RarebitDoc, thread.conversation.id, BACKGROUND_CONTEXT);
		for (const [, , key] of first) assert.equal(commands?.keys[key!], undefined);
		assert.equal(rarebit?.commands?.["title-A"], undefined);
		for (const restart of [false, true]) {
			if (restart) {
				client.close(); await daemon.stop();
				daemon = await runDaemon({ home, simTokensPerSecond: 500_000, plugins: await hydrate() });
				client = await TestClient.connect(daemon.socket); track();
			}
			const before = calls;
			const current = await daemon.runtime.thread(threadId);
			const tasks = (await current.store.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(t => t.record.kind === "pi.compaction").length;
			const replies = await Promise.allSettled(first.map(([name, args, key]) => command(name!, args!, key!)));
			assert.equal(calls, before, "replay of evicted title makes zero model requests");
			assert.ok(replies.every(r => r.status === "rejected" && r.reason.code === "command_expired"), JSON.stringify(replies));
			if (!restart) assert.equal((await thread.store.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(t => t.record.kind === "pi.compaction").length, tasks);
		}
	} finally { client.close(); await daemon.stop(); }
});

test("Rarebit keeps Title, selected evidence, compaction boundaries, and recall", async () => {
	writePiSettings({ compaction: { keepRecentTokens: 1 } });
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate() });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Add a health endpoint to the billing service" });
		const rarebit = client.sub({ kind: "rarebit", threadId });

		await client.until<any>(threads, (v) => v.threads[threadId]?.title === "Add a health endpoint to the billing");
		let view = await client.until<any>(rarebit, v => v.state.title && v.count === 2);
		assert.deepEqual(view.items.map((i: any) => `${i.role}/${i.outcome}`), ["user/user", "assistant/stop"]);
		assert.equal(view.state.summary, undefined);
		await client.req("thread.submit", { threadId, content: "Pick the storage engine for me /sim attention" });
		await client.until<any>(rarebit, v => v.count === 4);
		await client.req("thread.submit", { threadId, content: "Also add a readiness probe" });
		await client.until<any>(rarebit, v => v.count === 6);

		// After compaction the earlier evidence leaves model context, Rarebit still shows it, and the agent can
		// recall the exact first request.
		await client.req("thread.compact", { threadId });
		view = await client.until<any>(rarebit, (v) => v.items.some((i: any) => i.kind === "compaction"));
		const first = view.items[0];
		assert.equal(first.text, "Add a health endpoint to the billing service");
		assert.equal(first.outOfContext, true);
		await client.req("thread.submit", { threadId, content: '/sim tool rarebit_recall {"query":"health endpoint","role":"user"}' });
		const thread = client.sub({ kind: "thread", threadId });
		const done = await client.until<any>(thread, (v) => v.entries.some((e: any) => e.kind === "tool-result" && e.name === "rarebit_recall"));
		const recall = done.entries.find((e: any) => e.kind === "tool-result" && e.name === "rarebit_recall");
		assert.match(recall.text, /Add a health endpoint to the billing service/);
		assert.match(recall.text, /^2 of \d+ Rarebits match/, "the first request and the recall request itself");
		assert.deepEqual(client.gaps, [], "every replica applied a contiguous ops stream");
		client.close();
	} finally {
		await daemon.stop();
		writePiSettings(undefined);
	}
});
