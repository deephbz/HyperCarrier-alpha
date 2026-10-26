import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded, deferred, fixture } from "./composer-fixture.ts";

const users = (v: any): string[] => (v?.entries ?? []).filter((e: any) => e.kind === "user").map((e: any) => e.text);

async function queueFollowUp(f: Awaited<ReturnType<typeof fixture>>, run: string, text: string) {
	await f.enter(run);
	await f.page.getByRole("button", { name: "■ Stop", exact: true }).waitFor();
	await f.input.fill(text);
	await f.input.press("Alt+Enter");
	await f.page.locator(".queue-item .text").getByText(text, { exact: true }).waitFor();
	return f.page.locator(".queue-item").filter({ hasText: text });
}

test("Esc cancels a queued edit without a request or a stop; Enter saves it and the run places only the edited text", async (t) => {
	const f = await fixture(t, 200);
	const topic = f.wire.sub("devbox", { kind: "thread", threadId: f.threadId });
	const row = await queueFollowUp(f, "//sim long 3", "Old follow-up");
	await row.getByRole("button", { name: "Edit" }).click();
	const editor = f.page.getByRole("textbox", { name: "Edit queued message" });
	await editor.fill("Discarded edit");
	await editor.press("Escape");
	await f.page.locator(".queue-item .text").getByText("Old follow-up", { exact: true }).waitFor();
	assert.equal(await f.page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Message the agent", "Esc returns focus to the composer");
	assert.ok(!f.sent.some((frame) => frame.op === "thread.editQueued" || frame.op === "thread.abort"), "Esc sent nothing and did not stop the run");
	await f.page.getByRole("button", { name: "■ Stop", exact: true }).waitFor();

	await f.page.locator(".queue-item").filter({ hasText: "Old follow-up" }).getByRole("button", { name: "Edit" }).click();
	await editor.fill("New follow-up");
	await editor.press("Enter");
	await f.page.getByRole("status").filter({ hasText: "Queued message edited" }).waitFor();
	await f.page.locator(".queue-item .text").getByText("New follow-up", { exact: true }).waitFor();
	const view = await f.wire.until<any>(topic, (v) => users(v).includes("New follow-up"), 10_000);
	assert.deepEqual(users(view), ["/sim long 3", "New follow-up"]);
	assert.deepEqual(f.sent.filter((frame) => frame.op === "thread.submit").map((frame) => frame.args.content), ["/sim long 3", "Old follow-up"], "the edit resent nothing");
	assert.equal(await f.input.inputValue(), "");
	assert.deepEqual(f.errors, []);
});

test("a queued message the run takes during the edit keeps the edit as an unsent draft and sends nothing", async (t) => {
	const release = deferred<void>();
	const editSeen = deferred<void>();
	const f = await fixture(t, 200, false, false, (client) => {
		const server = client.connectToServer();
		client.onMessage(async (message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.editQueued") { editSeen.resolve(); await release.promise; }
			server.send(message);
		});
		server.onMessage((message) => client.send(message));
	});
	const topic = f.wire.sub("devbox", { kind: "thread", threadId: f.threadId });
	const row = await queueFollowUp(f, "//sim long 1", "Old follow-up");
	await row.getByRole("button", { name: "Edit" }).click();
	const editor = f.page.getByRole("textbox", { name: "Edit queued message" });
	await editor.fill("Edited follow-up");
	await editor.press("Enter");
	await bounded(editSeen.promise);
	// The run takes the original text while the edit is in flight.
	await f.wire.until<any>(topic, (v) => users(v).includes("Old follow-up"), 10_000);
	await f.page.getByText("Saving…").waitFor();
	release.resolve();
	await f.page.getByRole("status").filter({ hasText: "The agent already took this message, so your edit was not sent. Your edited text is in the composer." }).waitFor();
	assert.equal(await f.page.getByRole("alert").count(), 0, "a definite answer is a note, not an error");
	assert.equal(await f.input.inputValue(), "Edited follow-up", "the edited text is an unsent draft");
	assert.equal(await f.page.locator(".queue-item").count(), 0, "no queued row remains");
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.deepEqual(f.sent.filter((frame) => frame.op === "thread.submit").map((frame) => frame.args.content), ["/sim long 1", "Old follow-up"], "nothing was resent");
	const now = await f.wire.until<any>(topic, () => true);
	assert.deepEqual(users(now), ["/sim long 1", "Old follow-up"], "the run placed the original once and never the edit");
	assert.deepEqual(f.errors, []);
});

test("a Pi Session hides Edit and says once that Pi cannot edit a queued message", async (t) => {
	const f = await fixture(t, 200, true);
	await queueFollowUp(f, "//sim long 20", "Pi follow-up");
	await f.input.fill("Pi second");
	await f.input.press("Alt+Enter");
	await f.page.locator(".queue-item .text").getByText("Pi second", { exact: true }).waitFor();
	assert.equal(await f.page.locator(".queue").getByRole("button", { name: "Edit" }).count(), 0);
	assert.deepEqual(await f.page.locator(".queue-hint").allTextContents(), ["Pi cannot edit a queued message; Stop returns it to Pi's input box."]);
	assert.ok(!f.sent.some((frame) => frame.op === "thread.editQueued"));
});

test("a lost edit answer, then the run takes the message: the retry under the same editId answers edited and no draft is recovered", async (t) => {
	const release = deferred<void>();
	const retrySeen = deferred<void>();
	let edits = 0;
	const f = await fixture(t, 200, false, false, (client) => {
		const server = client.connectToServer();
		const first = new Set<number>();
		client.onMessage(async (message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.editQueued" && edits++ === 0) first.add(frame.id);
			else if (frame.op === "thread.editQueued") { retrySeen.resolve(); await release.promise; }
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(String(message));
			// The node committed the edit; its answer is lost on the way back.
			if (frame.t === "res" && first.has(frame.id)) return client.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: "timeout", message: "Edit reply lost in test transport" } }));
			client.send(message);
		});
	});
	const topic = f.wire.sub("devbox", { kind: "thread", threadId: f.threadId });
	const row = await queueFollowUp(f, "//sim long 1", "Old follow-up");
	await f.input.fill("My draft");
	await row.getByRole("button", { name: "Edit" }).click();
	const editor = f.page.getByRole("textbox", { name: "Edit queued message" });
	await editor.fill("Edited follow-up");
	await editor.press("Enter");
	await bounded(retrySeen.promise);
	// The run places the edited text before the retry reaches the node.
	await f.wire.until<any>(topic, (v) => users(v).includes("Edited follow-up"), 10_000);
	release.resolve();
	await f.page.getByRole("status").filter({ hasText: "Queued message edited" }).waitFor();
	assert.equal(await f.input.inputValue(), "My draft", "no draft recovery");
	assert.equal(await f.page.getByRole("alert").count(), 0);
	const saves = f.sent.filter((frame) => frame.op === "thread.editQueued");
	assert.equal(saves.length, 2);
	assert.equal(saves[1]!.args.editId, saves[0]!.args.editId, "the retry is the same edit");
	assert.deepEqual(f.sent.filter((frame) => frame.op === "thread.submit").map((frame) => frame.args.content), ["/sim long 1", "Old follow-up"]);
	assert.deepEqual(users(await f.wire.until<any>(topic, () => true)), ["/sim long 1", "Edited follow-up"]);
	assert.deepEqual(f.errors, []);
});

test("while A saves, B's Edit waits; after Esc on A, a late taken for A appends A's text and leaves B's editor intact", async (t) => {
	const release = deferred<void>();
	const editSeen = deferred<void>();
	const f = await fixture(t, 200, false, false, (client) => {
		const server = client.connectToServer();
		client.onMessage(async (message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.editQueued" && frame.args.text === "A edit") { editSeen.resolve(); await release.promise; }
			server.send(message);
		});
		server.onMessage((message) => client.send(message));
	});
	const topic = f.wire.sub("devbox", { kind: "thread", threadId: f.threadId });
	const a = await queueFollowUp(f, "//sim long 2", "A old");
	await f.input.fill("B old");
	await f.input.press("Alt+Enter");
	const b = f.page.locator(".queue-item").filter({ hasText: "B old" });
	await b.waitFor();
	await f.input.fill("My draft");
	await a.getByRole("button", { name: "Edit" }).click();
	const editor = f.page.getByRole("textbox", { name: "Edit queued message" });
	await editor.fill("A edit");
	await editor.press("Enter");
	await bounded(editSeen.promise);
	assert.equal(await b.getByRole("button", { name: "Edit" }).isDisabled(), true, "one save at a time");
	await editor.press("Escape");
	await b.getByRole("button", { name: "Edit" }).click();
	await editor.fill("B edit in progress");
	// The run takes A while A's save is still on its way to the node.
	await f.wire.until<any>(topic, (v) => users(v).includes("A old"), 10_000);
	release.resolve();
	await f.page.getByRole("status").filter({ hasText: "The agent already took this message, so your edit was not sent. Your edited text was added to the end of the composer." }).waitFor();
	assert.equal(await f.input.inputValue(), "My draft\n\nA edit", "A's text follows the draft; the draft stays");
	assert.equal(await editor.inputValue(), "B edit in progress", "B's editor is intact");
	assert.equal(await f.page.locator(".queue-edit").count(), 1);
	assert.deepEqual(f.sent.filter((frame) => frame.op === "thread.submit").map((frame) => frame.args.content), ["/sim long 2", "A old", "B old"]);
	assert.deepEqual(f.errors, []);
});

test("a queue editor belongs to its thread: switching threads shows no editor and sends nothing; coming back finds it closed", async (t) => {
	const f = await fixture(t, 200);
	await f.page.goto(`${f.origin}/?thread=${encodeURIComponent(f.threadId)}&unkeyed=1`);
	await f.input.waitFor();
	const row = await queueFollowUp(f, "//sim long 20", "Thread A follow-up");
	const { threadId: other } = await f.wire.req("devbox", "thread.create", { requestId: "edit-other", cwd: f.home, model: { provider: "ampi-sim", modelId: "sim-1" } });
	// Visit B once: its view stays warm, so the next switch keeps the same composer mounted, as in ThreadView.
	await f.page.evaluate((id) => (window as any).switchThread(id), other);
	await f.page.waitForFunction(() => document.querySelectorAll(".queue-item").length === 0);
	await f.page.evaluate((id) => (window as any).switchThread(id), f.threadId);
	await row.getByRole("button", { name: "Edit" }).click();
	await f.page.getByRole("textbox", { name: "Edit queued message" }).fill("Unsaved edit");
	await f.page.evaluate((id) => (window as any).switchThread(id), other);
	await f.page.waitForFunction(() => document.querySelectorAll(".queue-item").length === 0);
	await f.input.press("Enter");
	await f.page.evaluate((id) => (window as any).switchThread(id), f.threadId);
	await f.page.locator(".queue-item .text").getByText("Thread A follow-up", { exact: true }).waitFor();
	assert.equal(await f.page.locator(".queue-edit").count(), 0, "the editor closed on the switch");
	assert.ok(!f.sent.some((frame) => frame.op === "thread.editQueued"), "no edit request on any thread");
	assert.deepEqual(f.errors, []);
});

/** A transport whose `thread.editQueued` requests never reach the node: each waits for `gate`, then fails with `error`. */
function dropEdits(error: { code: string; message: string }) {
	const gate = deferred<void>();
	const seen = deferred<void>();
	// The page's sent-frames log shows only forwarded frames, so the transport keeps the dropped ones.
	const edits: any[] = [];
	const transport = (client: any) => {
		const server = client.connectToServer();
		client.onMessage(async (message: string) => {
			const frame = JSON.parse(String(message));
			if (frame.op !== "thread.editQueued") return server.send(message);
			edits.push(frame);
			seen.resolve();
			await gate.promise;
			client.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error }));
		});
		server.onMessage((message: string) => client.send(message));
	};
	return { gate, seen, edits, transport };
}

for (const [label, error, alert] of [
	["both answers are lost", { code: "timeout", message: "Edit reply lost in test transport" }, "Edit outcome unknown: your edited text is at the end of the composer; it may already have been sent. Check the queue before you send."],
	["the node refuses the edit", { code: "bad_request", message: "Refused in test" }, "Not saved: Refused in test. Your edited text is at the end of the composer; check the queue before you send."],
] as const)
	test(`Esc during a save, then ${label}: the edited text goes to the end of the draft and the alert names the composer`, async (t) => {
		const drop = dropEdits(error);
		const f = await fixture(t, 200, false, false, drop.transport);
		const row = await queueFollowUp(f, "//sim long 20", "Old follow-up");
		await f.input.fill("My draft");
		await row.getByRole("button", { name: "Edit" }).click();
		const editor = f.page.getByRole("textbox", { name: "Edit queued message" });
		await editor.fill("A edit");
		await editor.press("Enter");
		await bounded(drop.seen.promise);
		await editor.press("Escape");
		drop.gate.resolve();
		await f.page.getByRole("alert").filter({ hasText: alert }).waitFor();
		assert.equal(await f.input.inputValue(), "My draft\n\nA edit");
		await f.page.locator(".queue-item .text").getByText("Old follow-up", { exact: true }).waitFor();
		assert.ok(!f.sent.some((frame) => frame.op === "thread.submit" && frame.args.content === "A edit"), "nothing was sent");
		assert.deepEqual(f.errors, []);
	});

test("an older user entry with the edited text is no evidence: both answers lost leaves the outcome unknown", async (t) => {
	const drop = dropEdits({ code: "timeout", message: "Edit reply lost in test transport" });
	const f = await fixture(t, 200, false, false, drop.transport);
	const topic = f.wire.sub("devbox", { kind: "thread", threadId: f.threadId });
	await f.enter("Same text");
	const threads = f.wire.sub("devbox", { kind: "threads" });
	await f.wire.until<any>(threads, (v) => v.threads[f.threadId]?.activity === "idle" && users(f.wire.values.get(topic)).includes("Same text"), 10_000);
	const row = await queueFollowUp(f, "//sim long 20", "Old follow-up");
	await row.getByRole("button", { name: "Edit" }).click();
	const editor = f.page.getByRole("textbox", { name: "Edit queued message" });
	await editor.fill("Same text");
	drop.gate.resolve();
	await editor.press("Enter");
	await f.page.getByRole("alert").filter({ hasText: "Edit outcome unknown: your edited text is at the end of the composer; it may already have been sent." }).waitFor();
	assert.equal(await f.input.inputValue(), "Same text");
	assert.equal(await f.page.getByRole("status").filter({ hasText: "edited" }).count(), 0, "no claim that the edit landed");
	const saves = drop.edits;
	assert.deepEqual(saves.map((frame) => frame.args.retry), [false, true], "the second ask is a retry of the same edit");
	assert.equal(saves[1]!.args.editId, saves[0]!.args.editId);
	assert.deepEqual(f.errors, []);
});

test("an unknown edit outcome stays with the thread's draft: after keyed navigation away and back, the text and the warning return until dismissed", async (t) => {
	const drop = dropEdits({ code: "timeout", message: "Edit reply lost in test transport" });
	const f = await fixture(t, 200, false, false, drop.transport);
	const row = await queueFollowUp(f, "//sim long 20", "Old follow-up");
	await row.getByRole("button", { name: "Edit" }).click();
	const editor = f.page.getByRole("textbox", { name: "Edit queued message" });
	await editor.fill("A edit");
	await editor.press("Enter");
	await bounded(drop.seen.promise);
	const { threadId: other } = await f.wire.req("devbox", "thread.create", { requestId: "edit-away", cwd: f.home, model: { provider: "ampi-sim", modelId: "sim-1" } });
	// The default fixture keys the composer by thread, as App keys ThreadView, so this switch unmounts A's composer.
	await f.page.evaluate((id) => (window as any).switchThread(id), other);
	await f.page.waitForFunction(() => document.querySelectorAll(".queue-item").length === 0);
	drop.gate.resolve();
	const deadline = Date.now() + 10_000;
	while (drop.edits.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	assert.equal(drop.edits.length, 2, "the composer asked again before it gave up");
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(await f.input.inputValue(), "", "B's draft is untouched");
	await f.page.evaluate((id) => (window as any).switchThread(id), f.threadId);
	const alert = f.page.getByRole("alert").filter({ hasText: "Edit outcome unknown: your edited text is at the end of the composer; it may already have been sent." });
	await alert.waitFor();
	assert.equal(await f.input.inputValue(), "A edit");
	await alert.getByRole("button", { name: "Dismiss" }).click();
	await alert.waitFor({ state: "detached" });
	assert.equal(await f.input.inputValue(), "A edit", "Dismiss keeps the text");
	assert.deepEqual(f.errors, []);
});

test("a recovered draft's warning goes away when the owner edits the recovered text out of the draft", async (t) => {
	const drop = dropEdits({ code: "timeout", message: "Edit reply lost in test transport" });
	const f = await fixture(t, 200, false, false, drop.transport);
	const row = await queueFollowUp(f, "//sim long 20", "Old follow-up");
	await row.getByRole("button", { name: "Edit" }).click();
	const editor = f.page.getByRole("textbox", { name: "Edit queued message" });
	await editor.fill("A edit");
	drop.gate.resolve();
	await editor.press("Enter");
	const alert = f.page.getByRole("alert").filter({ hasText: "Edit outcome unknown" });
	await alert.waitFor();
	await f.input.fill("Something else");
	await alert.waitFor({ state: "detached" });
	assert.deepEqual(f.errors, []);
});

test("a late taken while the owner is on another thread: back on the edit's thread, the draft ends with the text and a dismissable note names the reason", async (t) => {
	const release = deferred<void>();
	const editSeen = deferred<void>();
	const answered = deferred<void>();
	const f = await fixture(t, 200, false, false, (client) => {
		const server = client.connectToServer();
		const edits = new Set<number>();
		client.onMessage(async (message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.editQueued") { edits.add(frame.id); editSeen.resolve(); await release.promise; }
			server.send(message);
		});
		server.onMessage((message) => {
			client.send(message);
			const frame = JSON.parse(String(message));
			if (frame.t === "res" && edits.has(frame.id)) answered.resolve();
		});
	});
	const topic = f.wire.sub("devbox", { kind: "thread", threadId: f.threadId });
	const row = await queueFollowUp(f, "//sim long 1", "Old follow-up");
	await f.input.fill("My draft");
	await row.getByRole("button", { name: "Edit" }).click();
	const editor = f.page.getByRole("textbox", { name: "Edit queued message" });
	await editor.fill("A edit");
	await editor.press("Enter");
	await bounded(editSeen.promise);
	await editor.press("Escape");
	const { threadId: other } = await f.wire.req("devbox", "thread.create", { requestId: "edit-late-away", cwd: f.home, model: { provider: "ampi-sim", modelId: "sim-1" } });
	// The default fixture keys the composer by thread, as App keys ThreadView, so this switch unmounts A's composer.
	await f.page.evaluate((id) => (window as any).switchThread(id), other);
	await f.page.waitForFunction(() => document.querySelectorAll(".queue-item").length === 0);
	await f.wire.until<any>(topic, (v) => users(v).includes("Old follow-up"), 10_000);
	release.resolve();
	await bounded(answered.promise);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(await f.input.inputValue(), "", "the other thread's draft is untouched");
	await f.page.evaluate((id) => (window as any).switchThread(id), f.threadId);
	const note = f.page.getByRole("alert").filter({ hasText: "The agent already took this message, so your edit was not sent. Your edited text is at the end of the composer." });
	await note.waitFor();
	assert.equal(await f.input.inputValue(), "My draft\n\nA edit");
	await note.getByRole("button", { name: "Dismiss" }).click();
	await note.waitFor({ state: "detached" });
	assert.equal(await f.input.inputValue(), "My draft\n\nA edit", "Dismiss keeps the text");
	assert.deepEqual(f.sent.filter((frame) => frame.op === "thread.submit").map((frame) => frame.args.content), ["/sim long 1", "Old follow-up"], "nothing was resent");
	assert.deepEqual(f.errors, []);
});

for (const code of ["unsupported", "key_conflict"] as const)
	test(`a final refusal (${code}) after keyed navigation away from an open, saving editor: back on its thread, the draft ends with the text and the refusal`, async (t) => {
		const drop = dropEdits({ code, message: `Refused ${code} in test` });
		const f = await fixture(t, 200, false, false, drop.transport);
		const row = await queueFollowUp(f, "//sim long 20", "Old follow-up");
		await f.input.fill("My draft");
		await row.getByRole("button", { name: "Edit" }).click();
		const editor = f.page.getByRole("textbox", { name: "Edit queued message" });
		await editor.fill("A edit");
		await editor.press("Enter");
		await bounded(drop.seen.promise);
		const { threadId: other } = await f.wire.req("devbox", "thread.create", { requestId: `edit-refused-${code}`, cwd: f.home, model: { provider: "ampi-sim", modelId: "sim-1" } });
		// The editor is still open and saving. The keyed switch unmounts it, as App unmounts ThreadView.
		await f.page.evaluate((id) => (window as any).switchThread(id), other);
		await f.page.waitForFunction(() => document.querySelectorAll(".queue-item").length === 0);
		drop.gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(drop.edits.length, 1, "a final refusal is not retried");
		assert.equal(await f.input.inputValue(), "", "the other thread's draft is untouched");
		await f.page.evaluate((id) => (window as any).switchThread(id), f.threadId);
		const alert = f.page.getByRole("alert").filter({ hasText: `Not saved: Refused ${code} in test. Your edited text is at the end of the composer; check the queue before you send.` });
		await alert.waitFor();
		assert.equal(await f.input.inputValue(), "My draft\n\nA edit");
		assert.equal(await f.page.locator(".queue-edit").count(), 0, "no stale editor");
		assert.deepEqual(f.errors, []);
	});
