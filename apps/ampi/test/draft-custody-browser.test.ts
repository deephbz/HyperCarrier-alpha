import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore: pi-hc-control is plain ESM.
import { IMAGE_LIMITS } from "@hypercarrier/pi-hc-control/control";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
import type { WebSocketRoute } from "playwright";
// @ts-ignore: browser fixture adapter is plain ESM.
import { routeFixture } from "../scripts/ux/fixtures.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

// Each submission keeps its own content until its outcome; a late outcome never writes over a newer draft (adv R1).
// The rejections are proven refusals (bad_request), so the held lines say Not sent.
for (const [engine, type, path] of ENGINES) {
	test(`draft custody ${engine}: late rejections are held beside the newer draft, Restore merges them, and navigation keeps the whole draft`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-worker-gui" });
		const submits: { id: number; requestId: string; content: string }[] = [];
		const reject = new Map<string, () => void>();
		await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
			connectToServer: () => ws.connectToServer(),
			onMessage: (fn: (message: string | Buffer) => void) => ws.onMessage((raw) => {
				const frame = JSON.parse(String(raw));
				if (frame.op === "thread.submit") submits.push({ id: frame.id, requestId: frame.args?.requestId, content: frame.args?.content });
				fn(raw);
			}),
			send: (raw: string) => {
				const frame = JSON.parse(raw);
				if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as { control?: boolean; images?: unknown }[]) {
					thread.control = true;
					thread.images = IMAGE_LIMITS;
				}
				const submit = frame.t === "res" && submits.find((s) => s.id === frame.id);
				if (submit) return void reject.set(submit.content, () => ws.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: "bad_request", message: `Synthetic rejection of ${submit.content}` } })));
				ws.send(JSON.stringify(frame));
			},
		}) });
		await page.reload();
		await page.getByTitle("Attach images (or paste or drop them)").waitFor();
		const input = page.getByRole("textbox", { name: "Message the agent" });
		const files = page.locator('.composer input[type="file"]');
		const attached = () => page.locator(".attachment").evaluateAll((els) => els.map((el) => el.getAttribute("title")));
		await files.setInputFiles({ name: "first.png", mimeType: "image/png", buffer: png });
		await page.locator('.attachment[title="first.png"]').waitFor();
		await input.fill("First message");
		await input.press("Enter");
		await input.fill("Second message");
		await input.press("Enter");
		await files.setInputFiles({ name: "next.png", mimeType: "image/png", buffer: png });
		await page.locator('.attachment[title="next.png"]').waitFor();
		await input.fill("Next draft must survive");
		for (let i = 0; i < 50 && reject.size < 2; i++) await page.waitForTimeout(100);
		assert.equal(new Set(submits.map((s) => s.requestId)).size, 2, `each send has its own request key: ${JSON.stringify(submits)}`);
		reject.get("First message")!();
		reject.get("Second message")!();
		const held = page.locator(".composer [role=alert].returned");
		await held.nth(1).waitFor();
		assert.deepEqual(await held.allTextContents().then((all) => all.map((line) => line.replace(/RestoreDiscard$/, ""))), [
			"Not sent: Synthetic rejection of First message. Your draft is kept; fix it and send again. “First message” with 1 image",
			"Not sent: Synthetic rejection of Second message. Your draft is kept; fix it and send again. “Second message”",
		].map((line) => line.replace(/[“”]/g, "")));
		assert.equal(await input.inputValue(), "Next draft must survive");
		assert.deepEqual(await attached(), ["next.png"]);
		await held.first().getByRole("button", { name: "Restore" }).click();
		assert.equal(await input.inputValue(), "First message\n\nNext draft must survive");
		assert.deepEqual(await attached(), ["next.png", "first.png"]);
		await held.first().getByRole("button", { name: "Discard" }).click();
		assert.equal(await held.count(), 0);
		// One draft holds text and images: leaving the Session and coming back keeps both.
		await page.getByRole("link", { name: "Overview", exact: true }).click();
		await input.waitFor({ state: "detached" });
		await page.goBack();
		await input.waitFor();
		assert.equal(await input.inputValue(), "First message\n\nNext draft must survive");
		assert.deepEqual(await attached(), ["next.png", "first.png"]);
	});
}

// A request key names exactly one unchanged payload whose outcome is uncertain (composer-drafts.ts).
for (const [engine, type, path] of ENGINES) {
	test(`draft custody ${engine}: a retry reuses the key only for an unchanged payload with an uncertain outcome`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-worker-gui" });
		const submits: { id: number; requestId: string; content: string }[] = [];
		// Only a coded refusal in FINAL_REFUSAL is final (composer-outcomes.ts); host_disconnected and timeout are uncertain.
		const codes = ["host_disconnected", "bad_request", "timeout"];
		await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
			connectToServer: () => ws.connectToServer(),
			onMessage: (fn: (message: string | Buffer) => void) => ws.onMessage((raw) => {
				const frame = JSON.parse(String(raw));
				if (frame.op === "thread.submit") submits.push({ id: frame.id, requestId: frame.args?.requestId, content: frame.args?.content });
				fn(raw);
			}),
			send: (raw: string) => {
				const frame = JSON.parse(raw);
				if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as { control?: boolean; images?: unknown }[]) thread.control = true;
				const at = frame.t === "res" ? submits.findIndex((s) => s.id === frame.id) : -1;
				if (at >= 0 && codes[at]) return void ws.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: codes[at], message: `Synthetic ${codes[at]}` } }));
				ws.send(JSON.stringify(frame));
			},
		}) });
		await page.reload();
		const input = page.getByRole("textbox", { name: "Message the agent" });
		await input.waitFor();
		const resend = async (n: number) => {
			await input.press("Enter");
			for (let i = 0; i < 50 && submits.length < n; i++) await page.waitForTimeout(100);
			assert.equal(submits.length, n, `submit ${n} went out`);
		};
		const given = async (text: string) => {
			for (let i = 0; i < 50 && (await input.inputValue()) !== text; i++) await page.waitForTimeout(100);
			assert.equal(await input.inputValue(), text, "the failed message is back in the draft");
		};
		await input.fill("Lost reply");
		await resend(1);
		await given("Lost reply");
		await resend(2);
		assert.equal(submits[1]!.requestId, submits[0]!.requestId, "an uncertain outcome retries under the same key");
		await given("Lost reply");
		await resend(3);
		assert.notEqual(submits[2]!.requestId, submits[1]!.requestId, "a final refusal sends again under a new key");
		await given("Lost reply");
		await input.pressSequentially("!");
		await resend(4);
		assert.equal(submits[3]!.content, "Lost reply!");
		assert.ok(!submits.slice(0, 3).some((s) => s.requestId === submits[3]!.requestId), `an edited payload takes a new key: ${JSON.stringify(submits)}`);
	});
}
