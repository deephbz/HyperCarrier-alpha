import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
import type { WebSocketRoute } from "playwright";
// @ts-ignore: browser fixture adapter is plain ESM.
import { routeFixture } from "../scripts/ux/fixtures.mjs";

// A typed `/name` reaches Pi only as a command: the Host's agent sends it through the control or types it into the
// pane. The composer never sends it through thread.submit, which a live control records as a user message. The
// control can look absent to one request and present to the next, so a no_control answer must not turn into a submit.
for (const [engine, type, path] of ENGINES) {
	test(`slash never message ${engine}: a no_control answer never sends a command as a message`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-worker-gui" });
		const sent: { op: string; content?: string; name?: string; asText?: boolean }[] = [];
		const noControl = { code: "no_control", message: "This Session has no live control socket" };
		let listError = noControl;
		const refusals: Record<string, { code: string; message: string }> = {
			no_control: noControl,
			commands_unsupported: { code: "commands_unsupported", message: "The AmPi agent is too old for slash commands" },
			editor_not_empty: { code: "editor_not_empty", message: "The Pi pane's input box is not empty" },
			unknown_command: { code: "unknown_command", message: "Pi has no /modle command that AmPi can type without a control socket" },
		};
		let command: "keys" | keyof typeof refusals = "keys";
		await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
			connectToServer: () => ws.connectToServer(),
			onMessage: (fn: (message: string | Buffer) => void) => ws.onMessage((raw) => {
				const frame = JSON.parse(String(raw));
				const answer = (ok: boolean, body: unknown) => ws.send(JSON.stringify({ t: "res", id: frame.id, ok, ...(ok ? { value: body } : { error: body }) }));
				if (frame.op === "thread.commands") return answer(false, listError);
				if (frame.op === "thread.command") {
					sent.push({ op: frame.op, name: frame.args?.name });
					return command === "keys" ? answer(true, { via: "keys", disposition: "dispatched", evidence: "sent" }) : answer(false, refusals[command]);
				}
				if (frame.op === "thread.submit") return void (sent.push({ op: frame.op, content: frame.args?.content, asText: frame.args?.asText }), answer(true, { via: "control", evidence: "started" }));
				fn(raw);
			}),
			send: (raw: string) => ws.send(raw),
		}) });
		await page.reload();
		const input = page.getByRole("textbox", { name: "Message the agent" });
		await input.waitFor();

		// The list has no control: the command still goes to the Host as a command, which types it into the pane.
		await input.fill("/model m2");
		await input.press("Enter");
		await page.waitForTimeout(300);
		assert.deepEqual(sent, [{ op: "thread.command", name: "model" }], "the command went as a command");
		assert.equal(await input.inputValue(), "", "the command took the draft");
		assert.match(await page.locator(".composer-feedback[role=status]").innerText(), /Typed \/model into the Pi pane \(no receipt/, "the note says what keys prove");

		// The agent cannot type it: the draft comes back with the reason, and nothing is sent as text.
		for (const code of ["no_control", "editor_not_empty"] as const) {
			sent.length = 0;
			command = code;
			await input.fill("/model m3");
			await input.press("Enter");
			await page.waitForTimeout(300);
			assert.deepEqual(sent, [{ op: "thread.command", name: "model" }], `${code}: a refused command is not sent again as a message`);
			assert.equal(await input.inputValue(), "/model m3", `${code}: a refused command gives the draft back`);
			assert.match(await page.locator("[data-outcome=refused]").innerText(), new RegExp(`Not sent: ${refusals[code]!.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `${code}: the reason shows`);
			await input.fill("");
		}

		// A name Pi does not run is a typo: the owner chooses, and only "Send as text" makes it a message.
		sent.length = 0;
		command = "unknown_command";
		await input.fill("/modle m3");
		await input.press("Enter");
		const choice = page.locator("[data-command-choice]");
		await choice.waitFor();
		assert.match(await choice.innerText(), /Pi has no \/modle command.*Nothing was sent\./);
		assert.deepEqual(sent, [{ op: "thread.command", name: "modle" }]);
		await choice.getByRole("button", { name: "Send as text" }).click();
		await page.waitForTimeout(300);
		assert.deepEqual(sent, [{ op: "thread.command", name: "modle" }, { op: "thread.submit", content: "/modle m3", asText: true }]);

		// The owner's explicit escape still sends slash text as a message.
		sent.length = 0;
		await input.fill("//model is a word");
		await input.press("Enter");
		await page.waitForTimeout(300);
		assert.deepEqual(sent, [{ op: "thread.submit", content: "/model is a word", asText: true }]);

		// An old agent can refuse the list, or the command after a no-control list. Neither refusal sends text.
		for (const tier of ["list", "command"]) {
			listError = tier === "list" ? refusals.commands_unsupported! : noControl;
			command = "commands_unsupported";
			sent.length = 0;
			await page.reload();
			await input.waitFor();
			await input.fill("/model m4");
			await input.press("Enter");
			await choice.waitFor();
			assert.match(await choice.innerText(), /too old.*Nothing was sent/);
			assert.deepEqual(sent, tier === "list" ? [] : [{ op: "thread.command", name: "model" }]);
			assert.equal(await input.inputValue(), "/model m4", "old-agent refusal returns the draft");
			await choice.getByRole("button", { name: "Edit", exact: true }).click();
			assert.equal(await input.inputValue(), "/model m4");
			assert.ok(sent.every(f => f.op !== "thread.submit"), "Edit never sends slash text");
		}
	});
}
