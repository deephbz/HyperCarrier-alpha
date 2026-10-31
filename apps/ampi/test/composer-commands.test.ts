import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture } from "./composer-fixture.ts";
import { hydrate } from "../src/plugins.ts";
import { engineSkip } from "./engines.ts";

test("Composer Enter routes durable audit and other built-ins through typed commands, never agent prose", async (t) => {
	const { home, wire, threadId, page, input, enter, sent, received, errors, origin } = await fixture(t);
	await enter("/export-system-prompt");
	await page.getByRole("alert").filter({ hasText: "No system prompt recorded yet for this thread." }).waitFor()
		.catch((error) => { throw new Error(`${error.message}; requests: ${JSON.stringify(sent.filter((f) => f.op).map((f) => ({ op: f.op, name: f.args?.name, content: f.args?.content })))}`); });
	assert.equal(await input.inputValue(), "/export-system-prompt", "empty audit keeps the draft");
	assert.equal(await page.locator("[data-outcome] > span").textContent(), "Not sent: No system prompt recorded yet for this thread. Your draft is kept; fix it and send again.");
	assert.ok(received.some((f: any) => f.t === "res" && f.error?.code === "audit_empty"), "the empty-audit command is an explicit pre-effect refusal");
	assert.equal(sent.filter((f) => f.op === "thread.submit").length, 0, "audit must not start a turn");
	await assert.rejects(wire.req("devbox", "audit.snapshot", { threadId }), { code: "not_found" });
	await enter("/not-a-command");
	await page.getByRole("alert").filter({ hasText: "This thread has no /not-a-command command. Nothing was sent." }).waitFor();
	assert.equal(await input.inputValue(), "/not-a-command");
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await enter("/settings");
	await page.getByRole("alert").filter({ hasText: "/settings is unavailable on this thread." }).waitFor();
	await enter("/context");
	await page.getByRole("status").filter({ hasText: "No model response yet" }).waitFor();
	assert.equal(sent.filter((f) => f.op === "thread.submit").length, 0, "unknown, unsupported, and local commands do not start turns");
	await enter("/cache 1h");
	await page.getByRole("status").filter({ hasText: "Cache TTL: 1h" }).waitFor();
	await enter("Hello");
	await wire.until<any>(wire.sub("devbox", { kind: "threads" }), (v) => v.threads[threadId]?.activity === "idle" && Boolean(v.threads[threadId]?.preview), 2000);
	await enter("/export-system-prompt review.json");
	await page.getByRole("status").filter({ hasText: "System prompt saved to" }).waitFor();
	const snapshot = await wire.req("devbox", "audit.snapshot", { threadId });
	const exported = JSON.parse(readFileSync(join(home, ".pi/prompt-snapshots/review.json"), "utf8"));
	assert.equal(exported.integrity.contentSha256, snapshot.integrity.contentSha256);
	assert.deepEqual(sent.filter((f) => f.op === "thread.submit").map((f) => f.args.content), ["Hello"]);
	assert.deepEqual(sent.filter((f) => f.op === "thread.command").map((f) => f.args.name), ["export-system-prompt", "cache", "export-system-prompt"]);
	const thread = wire.sub("devbox", { kind: "thread", threadId });
	const view = await wire.until<any>(thread, (v) => v.entries?.some((e: any) => e.kind === "assistant"), 2000);
	assert.deepEqual(view.entries.filter((e: any) => e.kind === "user").map((e: any) => e.text), ["Hello"]);
	await enter("  //literal-slash  \n");
	await wire.until<any>(thread, (v) => v.entries?.some((e: any) => e.kind === "user" && e.text === "  /literal-slash  \n"), 2000);
	assert.deepEqual(sent.filter((f) => f.op === "thread.submit").map((f) => f.args.content), ["Hello", "  /literal-slash  \n"]);
	// Exercise the existing Pi branch against the same typed server seam. This does not claim Pi-host parity.
	await page.goto(`${origin}/?thread=${encodeURIComponent(threadId)}&pi=1`);
	await enter("/cache status");
	await page.getByRole("status").filter({ hasText: "Cache TTL: 1h" }).waitFor();
	await enter("/not-a-command");
	await page.getByRole("alert").filter({ hasText: "Pi has no /not-a-command command. Nothing was sent." }).waitFor();
	await enter("/settings");
	await page.getByRole("alert").filter({ hasText: "/settings works only in the Pi pane." }).waitFor();
	assert.deepEqual(sent.filter((f) => f.op === "thread.submit").map((f) => f.args.content), ["Hello", "  /literal-slash  \n"]);
	assert.deepEqual(errors, []);
});

test("durable Composer removes +Image and sends pasted images", async (t) => {
	for (const browserName of ["chromium", "webkit"] as const) await t.test(browserName, { skip: engineSkip(browserName) }, async (t) => {
		const f = await fixture(t, 100_000, false, false, undefined, {}, browserName);
		// ThreadView passes the thread's summary row, which carries the node's image capability.
		await f.page.goto(`${f.origin}/?thread=${encodeURIComponent(f.threadId)}&summary=1`);
		assert.equal(await f.page.getByRole("button", { name: /Image/ }).count(), 0, `${browserName}: no image-attachment button`);
		await f.page.evaluate(() => window.addEventListener("ampi:accounts", (event) => {
			document.body.dataset.accountsHost = (event as CustomEvent).detail;
		}, { once: true }));
		await f.page.getByRole("combobox", { name: "Model" }).selectOption({ label: "Sign in to more models…" });
		await f.page.waitForFunction(() => document.body.dataset.accountsHost === "devbox");
		await f.page.evaluate(() => delete document.body.dataset.accountsHost);
		await f.page.evaluate(() => {
			const input = document.querySelector("textarea")!;
			const transfer = new DataTransfer();
			transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" }));
			input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
		});
		await f.page.getByRole("img", { name: "pasted.png" }).waitFor();
		await f.input.fill("Describe this image");
		await f.input.press("Enter");
		const submission = await f.submit(0);
		assert.equal(submission.args.content, "Describe this image");
		assert.deepEqual(submission.args.images, [{ data: "iVBORw==", mimeType: "image/png" }], `${browserName}: clipboard image is included in the submitted message`);
	});
});

test("durable plugin commands open Rarebit and ask before stopping a running turn", async (t) => {
	const f = await fixture(t, 200, false, false, undefined, { plugins: await hydrate() });
	await f.enter("/rarebit view");
	await f.page.getByRole("status").filter({ hasText: "Opened the Rarebit panel" }).waitFor();
	assert.equal(await f.page.locator("[data-panel]").textContent(), "rarebit");
	await f.enter("/rarebit menu");
	await f.page.getByRole("status").filter({ hasText: "Opened the Rarebit panel" }).waitFor();
	assert.equal(await f.page.locator("[data-panel-calls]").textContent(), "1", "an open panel is a no-op");
	await f.enter("/auto-compact status");
	const result = f.page.locator("[data-command-result]");
	await result.getByText("Auto Compact: on", { exact: true }).waitFor();
	assert.equal(await result.locator("details").getAttribute("open"), null);
	await result.locator("summary").click();
	assert.match(await result.innerText(), /Pi window-edge safety: on/);
	await f.enter("//sim long 100");
	await f.page.getByRole("button", { name: "■ Stop", exact: true }).waitFor();
	await f.enter("/auto-compact run retain decisions");
	await f.page.getByRole("button", { name: "Stop and compact", exact: true }).waitFor();
	assert.equal(f.sent.filter(frame => frame.op === "thread.command" && frame.args?.abort).length, 0);
	await f.page.getByRole("button", { name: "Stop and compact", exact: true }).click();
	await f.page.getByRole("status").filter({ hasText: "Same as /compact: compacting now" }).waitFor();
	assert.ok(f.sent.some(frame => frame.op === "thread.command" && frame.args?.abort === true && frame.args.name === "auto-compact"));
	assert.equal(await result.locator("details").count(), 0, "the next command replaces the report");
	assert.deepEqual(f.errors, []);
});

test("command bodies stay with their thread; late panel hints cannot navigate another thread", async (t) => {
	let held: (() => void) | undefined;
	let hold = false;
	const f = await fixture(t, 100_000, false, false, (client) => {
		const server = client.connectToServer();
		const commands = new Map<number, string>();
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.command") commands.set(frame.id, frame.args.args ?? "");
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "res" && frame.ok && commands.has(frame.id)) {
				frame.value = { ...frame.value, notice: "Report ready", body: "Budget report\nWorking budget: 120000\nNative safety: on\nMethod: HC summary", panel: "rarebit" };
				const send = () => client.send(JSON.stringify(frame));
				if (hold) { held = send; return; }
				send(); return;
			}
			client.send(message);
		});
	});
	const second = await f.wire.req("devbox", "thread.create", { requestId: "second", cwd: f.home, model: { provider: "ampi-sim", modelId: "sim-1" }, place: { workspace: "new", label: "second" } });
	await f.enter("/cache status");
	const report = f.page.locator("[data-command-result]");
	await report.waitFor();
	assert.equal(await report.locator("details").getAttribute("open"), null);
	await f.page.clock.install();
	await f.page.clock.fastForward(5000);
	assert.equal(await report.isVisible(), true, "command reports have no dismissal timer");
	await f.page.clock.resume();
	await report.getByText("Budget report", { exact: true }).click();
	assert.match(await report.innerText(), /Working budget: 120000/);
	assert.equal(await f.page.locator("[data-panel]").textContent(), "rarebit");
	await f.page.getByRole("button", { name: "Thread " + second.threadId, exact: true }).click();
	await report.waitFor({ state: "hidden" });
	await f.page.getByRole("button", { name: "Thread " + f.threadId, exact: true }).click();
	await report.waitFor();
	await report.getByRole("button", { name: "Dismiss" }).click();
	await report.waitFor({ state: "hidden" });
	await f.page.getByRole("button", { name: "Close panel" }).click();
	hold = true;
	await f.enter("/cache 1h");
	await f.page.waitForFunction(() => document.querySelector("textarea")?.value === "");
	await f.page.getByRole("button", { name: "Thread " + second.threadId, exact: true }).click();
	// The real node reply is held at the browser transport boundary.
	await new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + 1500;
		const check = () => held ? resolve() : Date.now() > deadline ? reject(new Error("No held reply")) : setTimeout(check, 10);
		check();
	});
	held!();
	await f.reply(f.sent.filter(frame => frame.op === "thread.command").at(-1)!.id!);
	assert.equal(await f.page.locator("[data-panel]").textContent(), "none");
	assert.equal(await report.count(), 0);
	await f.page.getByRole("button", { name: "Thread " + f.threadId, exact: true }).click();
	await report.waitFor();
	assert.equal(await f.page.locator("[data-panel]").textContent(), "none", "returning does not replay a panel hint");
	assert.deepEqual(f.errors, []);
});

for (const pi of [false, true]) test(pi
	? "Pi-mode Composer keeps its web draft and existing returned-input notice"
	: "Composer Esc restores returned durable queue texts before the draft, once, without sending them", async (t) => {
	const { wire, threadId, page, input, enter, sent, received, reply, submit, errors } = await fixture(t, 200, pi, true);
	const observedThread = wire.sub("devbox", { kind: "thread", threadId });
	await enter("//sim long 20");
	await page.getByRole("button", { name: "■ Stop", exact: true }).waitFor()
		.catch(async (error) => { throw new Error(`${error.message}; UI: ${await page.locator('body').innerText()}; requests: ${JSON.stringify(sent)}`); });
	for (const text of ["First queued text", "Second queued text"]) {
		await input.fill(text);
		await input.press("Alt+Enter");
		try {
			await wire.until<any>(observedThread, (view) => view.inbox?.items.some((item: any) => item.content === text), 1500);
			await page.locator(".queue-item .text").getByText(text, { exact: true }).waitFor();
		} catch (error) {
			const view = wire.values.get(observedThread) as any;
			throw new Error(`Queue did not reach ${JSON.stringify(text)}; last state: ${JSON.stringify({ draft: await input.inputValue(), requests: sent.filter((f) => f.op === "thread.submit"), replies: (received as any[]).filter((f) => f.t === "res"), run: view?.live?.run, inbox: view?.inbox })}`, { cause: error });
		}
	}
	const feedback = page.getByRole("alert").filter({ hasText: "Workbench did not answer." });
	await feedback.waitFor();
	assert.equal(await feedback.locator("> span").textContent(), `Workbench did not answer. Your message is back in the composer. ${pi ? "Check the Pi pane before sending again; it may already have arrived." : "Send again delivers it once; editing it makes a new message."}`);
	assert.equal(await input.inputValue(), "Second queued text", "a lost reply restores the retry draft");
	const sends = sent.filter((frame) => frame.op === "thread.submit");
	assert.equal(new Set(sends.map((frame) => frame.args.requestId)).size, 3, "each distinct send allocates its identity before any acknowledgement");
	await input.press("Alt+Enter");
	const retry = await submit(sends.length);
	const receipt = await reply(retry.id!);
	assert.equal(receipt.ok, true);
	assert.equal(retry.args.requestId, sends.at(-1)!.args.requestId, "retry keeps the unacknowledged send's identity");
	await input.fill("Unsent draft");
	await input.press("Escape");
	const threads = wire.sub("devbox", { kind: "threads" });
	await wire.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.queued === 0, 2000);
	await page.getByRole("status").filter({ hasText: "2 queued messages returned" }).waitFor();
	const abortRequest = sent.find((frame) => frame.op === "thread.abort") as { id: number } | undefined;
	assert.ok(abortRequest, "Esc sends an abort request");
	const ack = (received as any[]).find((frame) => frame.t === "res" && frame.id === abortRequest.id)?.value;
	assert.deepEqual(ack.submissions.map((s: any) => [s.state, s.text]), [["returned", "First queued text"], ["returned", "Second queued text"]]);
	assert.equal(new Set(ack.submissions.map((s: any) => s.submission)).size, 2, "returned messages have distinct identities");
	assert.equal(ack.submissions[1].submission, receipt.value.submission, "retry resolves to the second admission without adding another queue item");
	await page.getByRole("status").filter({ hasText: pi ? "returned to Pi's input box, not sent" : "returned to the composer, not sent" }).waitFor();
	const expected = pi ? "Unsent draft" : "First queued text\n\nSecond queued text\n\nUnsent draft";
	assert.equal(await input.inputValue(), expected);
	await input.press("Escape");
	assert.equal(await input.inputValue(), expected, "a repeated Esc adds no duplicate text");
	const view = await wire.until<any>(wire.sub("devbox", { kind: "thread", threadId }), (v) => v.inbox?.items.length === 2, 2000);
	assert.deepEqual(view.entries.filter((e: any) => e.kind === "user").map((e: any) => e.text), ["/sim long 20"], "queued input was returned without delivery");
	// Each settled row names the box that holds its text on this backend.
	const settled = page.locator(".queue-item.settled");
	await settled.nth(1).waitFor();
	assert.deepEqual(await settled.locator(".outcome").allTextContents(), Array(2).fill(pi ? "returned to Pi's input box" : "returned to the composer"));
	assert.deepEqual(await settled.getByRole("button", { name: "Edit here" }).evaluateAll((buttons) => buttons.map((b) => b.getAttribute("title"))), Array(2).fill(pi
		? "Put this text into the composer. Pi's input box still holds it, so clear one copy before you send."
		: "Put this text into the composer. Stop may already have put it there, so check the composer before you send."));
	assert.deepEqual(sent.filter((f) => f.op === "thread.submit").map((f) => f.args.content), ["/sim long 20", "First queued text", "Second queued text", "Second queued text"], "only the explicit retry repeats a submit; Esc never submits the restored draft");
	assert.deepEqual(errors, []);
});
