import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { IMAGE_LIMITS } from "@hypercarrier/pi-hc-control/control";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
import type { Page, WebSocketRoute } from "playwright";
// @ts-ignore: browser fixture adapter is plain ESM.
import { routeFixture } from "../scripts/ux/fixtures.mjs";

const ROUTE = "#/h/devbox/t/pi%3Asess-worker-gui";

async function enableImages(page: Page, count: number = IMAGE_LIMITS.count) {
	await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
		connectToServer: () => ws.connectToServer(),
		onMessage: (fn: (message: string | Buffer) => void) => ws.onMessage(fn),
		send: (raw: string) => {
			const frame = JSON.parse(raw);
			if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as { control?: boolean; images?: unknown }[]) {
				thread.control = true;
				thread.images = { ...IMAGE_LIMITS, count };
			}
			ws.send(JSON.stringify(frame));
		},
	}) });
	await page.reload();
	await page.locator('.composer input[type="file"]').waitFor({ state: "attached" });
}

async function dropPngs(page: Page, files: { name: string; kind: "valid" | "unreadable" | "oversize" }[]) {
	await page.locator(".composer-wrap").evaluate((el, files) => {
		const transfer = new DataTransfer();
		const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWJiYPj/HwAAAP//SnIwEgAAAAZJREFUAwADDAIB6Pxv8AAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
		for (const file of files) {
			const body = file.kind === "valid" ? png : file.kind === "oversize" ? new Uint8Array(5 * 1024 * 1024) : "not a PNG";
			transfer.items.add(new File([body], file.name, { type: "image/png" }));
		}
		el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
	}, files);
}

async function capture(page: Page, name: string) {
	const dir = join(process.cwd(), "output", "d21-feedback");
	mkdirSync(dir, { recursive: true });
	await page.screenshot({ path: join(dir, name), fullPage: true });
}

async function revealFeedbackScrollbar(page: Page) {
	const rect = await page.locator('.composer [role="alert"]').boundingBox();
	const viewport = page.viewportSize()!;
	if (rect) await page.mouse.move(Math.max(1, Math.min(rect.x + 8, viewport.width - 1)), Math.max(1, Math.min(rect.y + 8, viewport.height - 1)));
}

async function feedbackState(page: Page) {
	return page.evaluate(() => {
		const alert = document.querySelector<HTMLElement>('.composer [role="alert"]')!;
		const phrase = "Your draft is kept; correct the issue and try again.";
		const walker = document.createTreeWalker(alert, NodeFilter.SHOW_TEXT);
		let node: Node | null;
		while ((node = walker.nextNode()) && !node.textContent!.includes(phrase)) {}
		const recovery = document.createRange();
		if (node) {
			const start = node.textContent!.indexOf(phrase);
			recovery.setStart(node, start);
			recovery.setEnd(node, start + phrase.length);
		}
		const recoveryRect = node ? recovery.getBoundingClientRect() : null;
		const alertRect = alert.getBoundingClientRect();
		const send = document.querySelector<HTMLElement>('.composer-actions [aria-label^="Send"]')!.getBoundingClientRect();
		const draft = document.querySelector<HTMLElement>('.composer textarea[aria-label="Message the agent"]')!.getBoundingClientRect();
		const style = getComputedStyle(alert);
		return {
			text: alert.textContent ?? "",
			lines: (alert.textContent ?? "").split("\n"),
			alertHeight: alertRect.height,
			alertTop: alertRect.top,
			clientHeight: alert.clientHeight,
			scrollHeight: alert.scrollHeight,
			maxHeight: style.maxHeight,
			overflowY: style.overflowY,
			scrollbar: alert.dataset.scrollbar ?? "",
			quietThumb: style.getPropertyValue("--quiet-thumb").trim(),
			recoveryVisible: !!recoveryRect && recoveryRect.top >= alertRect.top && recoveryRect.bottom <= alertRect.bottom && recoveryRect.top >= 0 && recoveryRect.bottom <= innerHeight,
			sendInside: send.top >= 0 && send.bottom <= innerHeight,
			draftInside: draft.top >= 0 && draft.bottom <= innerHeight,
			viewportHeight: innerHeight,
		};
	});
}

// A valid image remains attachable in WebKit while an unreadable file retains the recovery refusal.
test("image admission webkit: attach readable image, refuse unreadable image", { skip: engineSkip("webkit") }, async (t) => {
	const [engine, type, path] = ENGINES.find(([engine]) => engine === "webkit")!;
	const page = await open(t, engine, type, path());
	await enableImages(page);
	await page.locator('.composer input[type="file"]').setInputFiles({ name: "readable.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWJiYPj/HwAAAP//SnIwEgAAAAZJREFUAwADDAIB6Pxv8AAAAABJRU5ErkJggg==", "base64") });
	await page.locator('.attachment[title="readable.png"]').waitFor();
	await page.locator('.composer input[type="file"]').setInputFiles({ name: "unreadable.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
	await page.waitForFunction(() => document.querySelector('.composer [role="alert"]')?.textContent?.includes("unreadable.png isn't a readable image"));
	assert.equal(await page.locator('.attachment[title="readable.png"]').count(), 1);
	assert.match(await page.locator('.composer [role="alert"]').innerText(), /unreadable\.png isn't a readable image, so it was not attached\./);
});

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
		await page.locator('.composer input[type="file"]').waitFor({state:"attached"});
		await page.locator(".composer-wrap").evaluate((el) => {
			const transfer = new DataTransfer();
			const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWJiYPj/HwAAAP//SnIwEgAAAAZJREFUAwADDAIB6Pxv8AAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
			for (let n = 1; n <= 9; n++) transfer.items.add(new File([png], `image-${n}.png`, { type: "image/png" }));
			transfer.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
			el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		});
		await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 8);
		const alert = (await page.locator(".composer [role=alert]").allTextContents()).join(" ");
		assert.match(alert, /image-9\.png not added: limit 8 per message\. Remove an image or send it in a separate message\./, `feedback=${JSON.stringify(alert)}`);
		assert.match(alert, /notes\.txt not added: not an image/, `feedback=${JSON.stringify(alert)}`);
	});

	test(`image admission ${engine}: a count-limit refusal names the next step`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE });
		await enableImages(page);
		await dropPngs(page, Array.from({ length: 20 }, (_, i) => ({ name: `valid-${i + 1}.png`, kind: "valid" as const })));
		await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 8);
		await page.waitForFunction(() => document.querySelector('.composer [role="alert"]')?.textContent?.includes("12 images not added"));
		const alert = await page.locator('.composer [role="alert"]').textContent();
		assert.ok(alert?.includes("12 images not added: limit 8 per message. Remove an image or send it in a separate message."), `count refusal includes its recovery step and final period: ${JSON.stringify(alert)}`);
	});

	test(`image admission ${engine}: the 3-problem drop stays full at 320x480`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE, context: { viewport: { width: 320, height: 480 } } });
		await enableImages(page);
		await dropPngs(page, [
			{ name: "readable.png", kind: "valid" },
			{ name: "unreadable-one.png", kind: "unreadable" },
			{ name: "unreadable-two.png", kind: "unreadable" },
			{ name: "oversize.png", kind: "oversize" },
		]);
		const alert = page.locator('.composer [role="alert"]');
		await page.waitForFunction(() => document.querySelector('.composer [role="alert"]')?.textContent?.includes("unreadable-two.png"));
		await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 1);
		await capture(page, `320x480-three-problems-${engine}.png`);
		const state = await feedbackState(page);
		assert.equal(state.lines.length, 3, `recovery, oversize issue, grouped unreadable issue: ${JSON.stringify(state.text)}`);
		assert.equal(state.lines[0], "Your draft is kept; correct the issue and try again.");
		assert.match(state.lines[1]!, /^oversize\.png not added: over 4\.5 MB in total per message\. Remove an image or send it in a separate message\.$/);
		assert.equal(state.lines[2], "2 files aren't readable images, so they were not attached: unreadable-one.png, unreadable-two.png.");
		assert.equal(state.scrollHeight, state.clientHeight, "the 3-problem message is visible without scrolling");
		assert.ok(state.recoveryVisible, "the draft recovery line is visible");
		assert.ok(state.sendInside && state.draftInside, "Send and draft remain inside the viewport");
		assert.equal(state.text.includes("Your draft is kept"), true, "role=alert retains the recovery line");
	});

	for (const scenario of [
		{ name: "320x480", width: 320, height: 480, zoom: 1 },
		{ name: "640x400-zoom200", width: 640, height: 400, zoom: 2 },
	] as const) {
		test(`image admission ${engine}: 20 unreadable files and an oversize image stay recoverable at ${scenario.name}`, { skip: engineSkip(engine) }, async (t) => {
			const page = await open(t, engine, type, path(), {
				route: ROUTE,
				display: { overall: scenario.zoom },
				context: { viewport: { width: scenario.width, height: scenario.height } },
			});
			await enableImages(page, 32);
			await dropPngs(page, [
				{ name: "oversize.png", kind: "oversize" },
				...Array.from({ length: 20 }, (_, i) => ({ name: `unreadable-${i + 1}.png`, kind: "unreadable" as const })),
			]);
			const alert = page.locator('.composer [role="alert"]');
			await page.waitForFunction(() => document.querySelector('.composer [role="alert"]')?.textContent?.includes("unreadable-20.png"));
			await revealFeedbackScrollbar(page);
			await capture(page, `${scenario.name}-${engine}.png`);
			const state = await feedbackState(page);
			const failures = [];
			if (!state.text.includes("Your draft is kept; correct the issue and try again.")) failures.push("role=alert loses the recovery line");
			for (let i = 1; i <= 20; i++) if (!state.text.includes(`unreadable-${i}.png`)) failures.push(`role=alert loses unreadable-${i}.png`);
			if (state.lines[0] !== "Your draft is kept; correct the issue and try again.") failures.push("recovery text is not first");
			if (!/^oversize\.png not added: over 4\.5 MB in total per message\. Remove an image or send it in a separate message\.$/.test(state.lines[1] ?? "")) failures.push("oversize issue line or next step is missing");
			if (state.lines[2] !== `20 files aren't readable images, so they were not attached: ${Array.from({ length: 20 }, (_, i) => `unreadable-${i + 1}.png`).join(", ")}.`) failures.push("unreadable files are not grouped into one line");
			if (state.scrollHeight <= state.clientHeight) failures.push("large feedback does not scroll inside its box");
			if (state.scrollbar === "none" || state.overflowY !== "auto") failures.push("the error box has no scrollbar");
			if (state.alertHeight > state.viewportHeight * 0.3 + 2) failures.push("feedback exceeds 30% of viewport");
			if (!state.recoveryVisible) failures.push("recovery line is not visible without scrolling");
			if (!state.sendInside || !state.draftInside) failures.push("Send or draft falls outside viewport");
			assert.deepEqual(failures, [], `role=alert should preserve recoverability: ${JSON.stringify(state)}`);
		});
	}

}
