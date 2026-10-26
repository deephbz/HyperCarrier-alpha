import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { lineReader } from "../src/shared/framing.ts";
import { bounded, deferred, fixture } from "./composer-fixture.ts";

test("host-link loss preserves message and typed-command keys while the browser remains connected", async (t) => {
	const held = [deferred<{ request: any; reply: any; sever: () => void }>(), deferred<{ request: any; reply: any; sever: () => void }>()];
	let holding = 0;
	const f = await fixture(t, 100_000, false, false, undefined, {
		prompts: { "retry-probe": "Command admitted $1." },
		transport(socket) {
			const requests = new Map<number, any>();
			socket.on("data", lineReader((line) => {
				const frame = JSON.parse(line);
				if (frame.op === "thread.submit" || frame.op === "thread.command") requests.set(frame.id, frame);
			}));
			const write = socket.write.bind(socket);
			// Hold the real node receipt before it reaches the hub. All subscriptions still flow.
			socket.write = ((chunk: any, ...args: any[]) => {
				const frame = JSON.parse(String(chunk));
				const request = requests.get(frame.id);
				if (frame.t === "res" && request && ((holding === 0 && request.op === "thread.submit") || (holding === 1 && request.op === "thread.command"))) {
					held[holding++]!.resolve({ request, reply: frame, sever: () => socket.destroy() });
					return true;
				}
				return (write as any)(chunk, ...args);
			}) as typeof socket.write;
		},
	});
	let browserReconnects = 0;
	f.page.on("websocket", () => browserReconnects++);
	const topic = f.wire.sub("devbox", { kind: "thread", threadId: f.threadId });
	for (const [index, text, expected] of [[0, "Message admitted once", "Message admitted once"], [1, "/retry-probe once", "Command admitted once."]] as const) {
		await f.enter(text);
		const receipt = await bounded(held[index]!.promise);
		assert.equal(receipt.reply.ok, true);
		const op = index === 0 ? "thread.submit" : "thread.command";
		const original = f.sent.find((frame) => frame.op === op)!;
		receipt.sever();
		const failure = await f.reply(original.id!);
		assert.equal(failure.error.code, "host_disconnected", "the hub reports the real host-link break");
		const alert = f.page.getByRole("alert");
		await alert.waitFor();
		assert.equal(await alert.innerText(), "Workbench did not answer. Your message is back in the composer. Send again delivers it once; editing it makes a new message.");
		assert.doesNotMatch(await alert.innerText(), /#|disconnected|correct the issue/);
		await f.wire.when(() => f.wire.hosts.some((host) => host.id === "devbox" && host.status === "connected"), 1500);
		await f.page.waitForFunction((text) => document.querySelector("textarea")?.value === text, text);
		await f.input.press("Enter");
		await f.page.waitForFunction(() => document.querySelector("textarea")?.value === "");
		const retry = f.sent.filter((frame) => frame.op === op).at(-1)!;
		assert.deepEqual(retry.args, original.args, "retry uses the original key and exact payload");
		const retried = await f.reply(retry.id!);
		assert.deepEqual(retried.value, receipt.reply.value, "node returns the original receipt");
		const view = await f.wire.until<any>(topic, (v) => v.entries?.some((entry: any) => entry.kind === "user" && entry.text === expected), 1500);
		assert.equal(view.entries.filter((entry: any) => entry.kind === "user" && entry.text === expected).length, 1);
	}
	assert.equal(browserReconnects, 0, "the browser WebSocket never closes");
	assert.deepEqual(f.errors, []);
});

test("key_conflict is final: show the node refusal, keep plain text, and allocate a new send ID", async (t) => {
	let count = 0, first: number | undefined;
	const f = await fixture(t, 100_000, false, false, (client) => {
		const server = client.connectToServer();
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.submit") {
				count++;
				if (count === 1) first = frame.id;
				// The real node refuses the changed payload under an already-admitted key.
				if (count === 2) { frame.args.content = "Transport changed this payload"; server.send(JSON.stringify(frame)); return; }
			}
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "res" && frame.id === first) {
				client.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: "timeout", message: "Admission reply lost" } }));
				return;
			}
			client.send(message);
		});
	});
	await f.enter("Original");
	await f.page.getByRole("alert").filter({ hasText: "Workbench did not answer." }).waitFor();
	const original = await f.submit(0);
	await f.input.press("Enter");
	const retry = await f.submit(1);
	const refusal = await f.reply(retry.id!);
	assert.equal(refusal.error.code, "key_conflict");
	const feedback = f.page.getByRole("alert").filter({ hasText: refusal.error.message });
	await feedback.waitFor();
	assert.equal(await feedback.textContent(), `Not sent: ${refusal.error.message.replace(/\.+$/, "")}. Your draft is kept; fix it and send again.`);
	assert.equal(await f.input.inputValue(), "Original");
	assert.equal(retry.args.requestId, original.args.requestId);
	await f.input.press("Enter");
	const fresh = await f.submit(2);
	assert.notEqual(fresh.args.requestId, original.args.requestId);
	assert.equal(fresh.args.content, "Original");
	assert.equal((await f.reply(fresh.id!)).ok, true);
	assert.deepEqual(f.errors, []);
});
