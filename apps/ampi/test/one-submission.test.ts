import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
import type { WebSocketRoute } from "playwright";
// @ts-ignore: browser fixture adapter is plain ESM.
import { routeFixture } from "../scripts/ux/fixtures.mjs";

// One draft yields at most one submission. The send takes the draft before any await, so a second activation in the
// same tick (a double click, a repeated key, Send then Steer) finds an empty draft. The Pi command path awaits the
// command list first, which is the widest window; the plain path has no await but reads the draft once.
for (const [engine, type, path] of ENGINES) {
	test(`one submission ${engine}: two activations in one tick send a draft once`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-worker-gui" });
		const sent: { op: string; content?: string; name?: string }[] = [];
		const held: (() => void)[] = [];
		let hold = false;
		await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
			connectToServer: () => ws.connectToServer(),
			onMessage: (fn: (message: string | Buffer) => void) => ws.onMessage((raw) => {
				const frame = JSON.parse(String(raw));
				const reply = (value: unknown) => ws.send(JSON.stringify({ t: "res", id: frame.id, ok: true, value }));
				// The command list waits until the test lets it go, so both activations reach the await.
				if (frame.op === "thread.commands") return void (hold ? held.push.bind(held) : (f: () => void) => f())(() => reply({ commands: [{ name: "model", source: "builtin", supported: true }, { name: "tree", source: "builtin", supported: false }], models: [], model: null, thinkingLevels: [] }));
				if (frame.op === "thread.command") return void (sent.push({ op: frame.op, name: frame.args?.name }), reply({ disposition: "done" }));
				if (frame.op === "thread.submit") sent.push({ op: frame.op, content: frame.args?.content });
				fn(raw);
			}),
			send: (raw: string) => {
				const frame = JSON.parse(raw);
				if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as { control?: boolean }[]) thread.control = true;
				ws.send(JSON.stringify(frame));
			},
		}) });
		await page.reload();
		const input = page.getByRole("textbox", { name: "Message the agent" });
		await input.waitFor();
		const twice = (how: "keys" | "clicks") => page.evaluate((how) => {
			const field = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
			const send = [...document.querySelectorAll<HTMLButtonElement>(".composer-bar button")].find((b) => /Send|Steer/.test(b.textContent ?? ""))!;
			for (let i = 0; i < 2; i++) {
				if (how === "keys") field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
				else send.click();
			}
		}, how);

		for (const how of ["keys", "clicks"] as const) {
			sent.length = 0;
			hold = true;
			await input.fill("/model m2");
			await twice(how);
			hold = false;
			while (held.length) held.shift()!();
			await page.waitForTimeout(300);
			assert.deepEqual(sent, [{ op: "thread.command", name: "model" }], `${how}: the Pi command is sent once`);
			assert.equal(await input.inputValue(), "", `${how}: the command took the draft`);

			sent.length = 0;
			await input.fill(`Plain message by ${how}`);
			await twice(how);
			await page.waitForTimeout(300);
			assert.deepEqual(sent, [{ op: "thread.submit", content: `Plain message by ${how}` }], `${how}: the message is sent once`);
		}

		// A command that sends nothing gives its draft back; a choice sends only the submission it claims.
		sent.length = 0;
		await input.fill("/nope keep this");
		await input.press("Enter");
		const choice = page.locator("[data-command-choice]");
		await choice.waitFor();
		assert.match(await choice.innerText(), /Pi has no \/nope command\. Nothing was sent\./);
		assert.equal(await input.inputValue(), "/nope keep this", "an unknown command gives the draft back");
		await choice.getByRole("button", { name: "Send as text" }).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
		await page.waitForTimeout(300);
		assert.deepEqual(sent, [{ op: "thread.submit", content: "/nope keep this" }], "a double click on Send as text sends once");
		assert.equal(await input.inputValue(), "");

		sent.length = 0;
		await input.fill("/tree");
		await input.press("Enter");
		await page.getByText("/tree works only in the Pi pane.").waitFor();
		assert.equal(await input.inputValue(), "/tree", "an unsupported command gives the draft back");
		assert.deepEqual(sent, []);
	});
}
