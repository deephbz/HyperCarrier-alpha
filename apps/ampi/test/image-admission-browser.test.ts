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

// The Composer admits every dropped file or names why not (adv R1: nine images kept eight and dropped the ninth silently).
for (const [engine, type, path] of ENGINES) {
	test(`image admission ${engine}: a drop past the Session's limits names each file not added`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-worker-gui" });
		// A synthetic Pi control that takes images. The shared fixture adapter blocks all mutations.
		await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
			connectToServer: () => ws.connectToServer(),
			onMessage: (fn: (message: string | Buffer) => void) => ws.onMessage(fn),
			send: (raw: string) => {
				const frame = JSON.parse(raw);
				if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as { control?: boolean; images?: unknown }[]) {
					thread.control = true;
					thread.images = IMAGE_LIMITS;
				}
				ws.send(JSON.stringify(frame));
			},
		}) });
		await page.reload();
		await page.getByTitle("Attach images (or paste or drop them)").waitFor();
		await page.locator(".composer-wrap").evaluate((el) => {
			const transfer = new DataTransfer();
			const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
			for (let n = 1; n <= 9; n++) transfer.items.add(new File([png], `image-${n}.png`, { type: "image/png" }));
			transfer.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
			el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		});
		await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 8);
		const alert = (await page.locator(".composer [role=alert]").allTextContents()).join(" ");
		assert.match(alert, /image-9\.png not added: limit 8 per message/, `feedback=${JSON.stringify(alert)}`);
		assert.match(alert, /notes\.txt not added: not an image/, `feedback=${JSON.stringify(alert)}`);
	});
}
