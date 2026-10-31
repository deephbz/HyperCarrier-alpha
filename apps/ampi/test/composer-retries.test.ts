import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded, deferred, fixture } from "./composer-fixture.ts";

// Draft custody (composer-drafts.ts): a send that fails late waits beside the newer draft as a held message. Only a
// whole restore into an empty draft keeps its key and request, so only that retry is placed at most once.
const held = (f: { page: import("playwright").Page }, text?: string) => {
	const rows = f.page.locator(".composer-feedback.returned");
	return text === undefined ? rows : rows.filter({ hasText: text });
};

test("two unknown sends survive reconnect and Session switch; each retries alone under its original key", async (t) => {
	const admitted: any[] = [];
	const bothAdmitted = deferred<void>();
	let disconnect: (() => void) | undefined;
	const f = await fixture(t, 100_000, false, false, (client) => {
		const server = client.connectToServer();
		const hold = new Set<number>();
		disconnect = () => client.close();
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.submit" && admitted.length < 2) hold.add(frame.id);
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "res" && hold.has(frame.id)) { admitted.push(frame); if (admitted.length === 2) bothAdmitted.resolve(); return; }
			client.send(message);
		});
	});
	const topic = f.wire.sub("devbox", { kind: "thread", threadId: f.threadId });
	await f.enter("First");
	await f.wire.until<any>(topic, (v) => v.entries?.some((e: any) => e.kind === "user" && e.text === "First"), 1500);
	await f.input.fill("Second");
	await f.input.press("Alt+Enter");
	await f.wire.until<any>(topic, (v) => v.entries?.some((e: any) => e.kind === "user" && e.text === "Second"), 1500);
	await f.input.fill("New draft");
	await bounded(bothAdmitted.promise);
	assert.equal(admitted.length, 2);
	disconnect!();
	await held(f, "First").waitFor();
	await held(f, "Second").waitFor();
	assert.equal(await f.input.inputValue(), "New draft", "a late outcome never writes over the newer draft");
	const { threadId: other } = await f.wire.req("devbox", "thread.create", {
		requestId: "other-session", cwd: f.home, model: { provider: "ampi-sim", modelId: "sim-1" },
	});
	await f.page.evaluate((id) => (window as any).switchThread(id), other);
	await f.page.waitForFunction(() => document.querySelector("textarea")?.value === "");
	assert.equal(await held(f).count(), 0, "held messages stay with their Session");
	await f.page.evaluate((id) => (window as any).switchThread(id), f.threadId);
	await f.page.waitForFunction(() => document.querySelector("textarea")?.value === "New draft");
	assert.equal(await held(f).count(), 2);
	await f.input.press("Enter");
	assert.equal((await f.reply((await f.submit(2)).id!)).ok, true);
	for (const [i, text] of [[3, "First"], [4, "Second"]] as const) {
		await held(f, text).getByRole("button", { name: "Restore" }).click();
		await f.page.waitForFunction((value) => document.querySelector("textarea")?.value === value, text);
		await f.input.press("Enter");
		await f.submit(i);
	}
	const sends = f.sent.filter((frame) => frame.op === "thread.submit");
	assert.deepEqual(sends.map((frame) => frame.args.content), ["First", "Second", "New draft", "First", "Second"]);
	assert.deepEqual(sends[3]!.args, sends[0]!.args, "a whole restore retries the same request under the same key");
	assert.deepEqual(sends[4]!.args, sends[1]!.args);
	assert.equal(sends[0]!.args.whenBusy, "steer");
	assert.equal(sends[1]!.args.whenBusy, "followUp");
	assert.ok(![sends[0]!.args.requestId, sends[1]!.args.requestId].includes(sends[2]!.args.requestId));
	assert.notEqual(sends[0]!.args.requestId, sends[1]!.args.requestId);
	for (let i = 0; i < 2; i++) assert.equal((await f.reply(sends[i + 3]!.id!)).value.submission, admitted[i].value.submission);
	const view = await f.wire.until<any>(topic, (v) => v.entries?.some((e: any) => e.kind === "user" && e.text === "New draft"), 1500);
	assert.deepEqual(view.entries.filter((e: any) => e.kind === "user").map((e: any) => e.text), ["First", "Second", "New draft"]);
	assert.deepEqual(f.errors, []);
});

test("a late failure keeps the newer draft; restoring it into that draft sends a new message under a new key", async (t) => {
	const failed = deferred<() => void>();
	let first: number | undefined;
	const f = await fixture(t, 100_000, false, false, (client) => {
		const server = client.connectToServer();
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.submit" && first === undefined) first = frame.id;
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "res" && frame.id === first) {
				failed.resolve(() => client.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: "timeout", message: "Admission reply lost" } })));
				return;
			}
			client.send(message);
		});
	});
	await f.enter("Old send");
	await f.wire.until<any>(f.wire.sub("devbox", { kind: "thread", threadId: f.threadId }), (v) => v.entries?.some((e: any) => e.kind === "user"), 1500);
	await f.input.fill("New typed draft");
	(await bounded(failed.promise))();
	await held(f, "Old send").waitFor();
	assert.equal(await f.input.inputValue(), "New typed draft");
	await held(f, "Old send").getByRole("button", { name: "Restore" }).click();
	await f.page.waitForFunction(() => document.querySelector("textarea")?.value === "Old send\n\nNew typed draft");
	assert.equal(await held(f).count(), 0);
	await f.input.press("Enter");
	const merged = await f.submit(1);
	assert.equal(merged.args.content, "Old send\n\nNew typed draft");
	assert.notEqual(merged.args.requestId, (await f.submit(0)).args.requestId, "a merged payload is a new message");
	assert.equal(f.sent.filter((frame) => frame.op === "thread.submit").length, 2, "nothing retries by itself");
	assert.deepEqual(f.errors, []);
});

test("a failure released while Session A is absent is held in A; B's newer draft stays", async (t) => {
	const released = deferred<() => void>();
	let first: number | undefined;
	const f = await fixture(t, 100_000, false, false, (client) => {
		const server = client.connectToServer();
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.submit" && first === undefined) first = frame.id;
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "res" && frame.id === first) {
				released.resolve(() => client.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: "future_transport_error", message: "Outcome is not confirmed" } })));
				return;
			}
			client.send(message);
		});
	});
	await f.enter("A's input");
	const release = await bounded(released.promise);
	const original = await f.submit(0);
	const { threadId: other } = await f.wire.req("devbox", "thread.create", {
		requestId: "late-failure-other", cwd: f.home, model: { provider: "ampi-sim", modelId: "sim-1" },
	});
	await f.page.evaluate((id) => (window as any).switchThread(id), other);
	await f.page.waitForFunction(() => document.querySelector("textarea")?.value === "");
	await f.input.fill("B's newer draft");
	release();
	assert.equal((await f.reply(original.id!, "future_transport_error")).error.code, "future_transport_error");
	// A failure must not write through the mounted B component's state.
	await f.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
	assert.equal(await f.input.inputValue(), "B's newer draft");
	assert.equal(await held(f).count(), 0);
	await f.page.evaluate((id) => (window as any).switchThread(id), f.threadId);
	await held(f, "A's input").waitFor();
	assert.equal(await f.input.inputValue(), "", "off screen, the failure is held, not put into the draft");
	await held(f, "A's input").getByRole("button", { name: "Restore" }).click();
	await f.page.waitForFunction(() => document.querySelector("textarea")?.value === "A's input");
	await f.input.press("Enter");
	const retry = await f.submit(1);
	assert.equal(retry.args.requestId, original.args.requestId, "an unrecognized error cannot prove refusal");
	assert.equal((await f.reply(retry.id!)).ok, true);
	await f.page.evaluate((id) => (window as any).switchThread(id), other);
	await f.page.waitForFunction(() => document.querySelector("textarea")?.value === "B's newer draft");
	assert.deepEqual(f.errors, []);
});

test("an expired command retry shows the refusal and the next Enter allocates a new key", async t => {
	let first: number | undefined;
	const f = await fixture(t, 100_000, false, false, client => {
		const server = client.connectToServer();
		client.onMessage(message => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.command" && first === undefined) first = frame.id;
			server.send(message);
		});
		server.onMessage(message => {
			const frame = JSON.parse(String(message));
			if (frame.t === "res" && frame.id === first) {
				client.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: "timeout", message: "Reply lost" } }));
				return;
			}
			client.send(message);
		});
	});
	await f.enter("/cache 1h");
	await f.page.getByRole("alert").filter({ hasText: "did not answer" }).waitFor();
	for (let i = 0; i < 201; i++) await f.wire.req("devbox", "thread.command", { threadId: f.threadId, name: "cache", args: "status", key: `evict-${i}` });
	await f.input.press("Enter");
	await f.page.getByRole("alert").filter({ hasText: "The node no longer knows this command's result. Press Enter to run it again." }).waitFor({ timeout: 2000 });
	await f.input.press("Enter");
	await f.page.getByRole("status").filter({ hasText: "Cache TTL: 1h" }).waitFor();
	const commands = f.sent.filter(frame => frame.op === "thread.command");
	assert.equal(commands.length, 3);
	assert.equal(commands[0]!.args.key, commands[1]!.args.key);
	assert.notEqual(commands[1]!.args.key, commands[2]!.args.key);
	assert.deepEqual(f.errors, []);
});

test("two typed commands allocate separate keys before a delayed reply and both execute", async (t) => {
	const commands: any[] = [];
	let held: string | Buffer | undefined;
	const f = await fixture(t, 100_000, false, false, (client) => {
		const server = client.connectToServer();
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.command") commands.push(frame);
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "res" && frame.id === commands[0]?.id) { held = message; return; }
			if (frame.t === "res" && frame.id === commands[1]?.id && held !== undefined) { client.send(held); held = undefined; }
			client.send(message);
		});
	});
	await f.enter("/cache 1h");
	await f.page.waitForFunction(() => document.querySelector("textarea")?.value === "");
	await f.enter("/cache 5m");
	await f.page.getByRole("status").filter({ hasText: "Cache TTL: 5m" }).waitFor();
	assert.equal(commands.length, 2);
	assert.notEqual(commands[0].args.key, commands[1].args.key);
	for (const command of commands) assert.equal((await f.reply(command.id)).ok, true);
	const status = await f.wire.req("devbox", "thread.command", { threadId: f.threadId, name: "cache", args: "status", key: "verify-cache-status", whenBusy: "steer" });
	assert.equal(status.notice, "Cache TTL: 5m");
	assert.deepEqual(f.errors, []);
});
