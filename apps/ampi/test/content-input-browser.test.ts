import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSocketRoute } from "playwright";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
// @ts-ignore: browser fixture adapter is plain ESM.
import { routeFixture } from "../scripts/ux/fixtures.mjs";
import { CONTENT_IMAGE_BASE64_EACH, CONTENT_IMAGE_COUNT, CONTENT_IMAGE_TOTAL_BASE64, CONTENT_LONG_DRAFT, CONTENT_OVERSIZE_IMAGE_BASE64 } from "../scripts/demo/data/content.ts";

const ROUTE = "#/h/devbox/t/pi%3Asess-worker-gui";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWJiYPj/HwAAAP//SnIwEgAAAAZJREFUAwADDAIB6Pxv8AAAAABJRU5ErkJggg==";

async function enableImageControl(page: Awaited<ReturnType<typeof open>>) {
	await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
		connectToServer: () => ws.connectToServer(),
		onMessage: (fn: (message: string | Buffer) => void) => ws.onMessage(fn),
		send: (raw: string) => {
			const frame = JSON.parse(raw);
			if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as { control?: boolean; images?: unknown }[]) {
				thread.control = true;
				thread.images = { count: CONTENT_IMAGE_COUNT, totalBase64: CONTENT_IMAGE_TOTAL_BASE64, types: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
			}
			ws.send(JSON.stringify(frame));
		},
	}) });
	await page.reload();
	await page.locator('.composer input[type="file"]').waitFor({ state: "attached" });
}

for (const [engine, type, path] of ENGINES) {
	test(`composer content ${engine}: long draft keeps actions reachable at 320 px`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE });
		await page.setViewportSize({ width: 320, height: 640 });
		await enableImageControl(page);
		const input = page.getByRole("textbox", { name: "Message the agent" });
		await input.fill(CONTENT_LONG_DRAFT);
		assert.equal(await input.inputValue(), CONTENT_LONG_DRAFT);
		const action = page.getByRole("button", { name: /Send/ });
		const box = await action.boundingBox();
		assert.ok(box, "Send stays visible after a long draft");
		assert.ok(box.y + box.height <= 640, `Send is inside the viewport: ${JSON.stringify(box)}`);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the page does not scroll sideways");
	});

	test(`composer content ${engine}: eight images at the byte limit stay reachable`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE });
		await page.setViewportSize({ width: 320, height: 640 });
		await enableImageControl(page);
		await page.locator(".composer-wrap").evaluate((element, { count, bytes, base64 }: { count: number; bytes: number; base64: string }) => {
			const transfer = new DataTransfer();
			const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
			for (let i = 0; i < count; i++) {
				const data = new Uint8Array(bytes);
				data.set(binary);
				transfer.items.add(new File([data], `content-${i + 1}.png`, { type: "image/png" }));
			}
			element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		}, { count: CONTENT_IMAGE_COUNT, bytes: Math.floor(CONTENT_IMAGE_BASE64_EACH * 3 / 4), base64: PNG });
		await page.waitForFunction((count) => document.querySelectorAll(".attachment").length === count, CONTENT_IMAGE_COUNT);
		const total = await page.locator(".attachment img").evaluateAll((images) => images.reduce((sum, image) => sum + ((image as HTMLImageElement).src.split(",")[1]?.length ?? 0), 0));
		assert.equal(total, CONTENT_IMAGE_TOTAL_BASE64, "the fixture reaches the accepted base64 total exactly");
		const action = await page.getByRole("button", { name: /Send/ }).boundingBox();
		assert.ok(action && action.y + action.height <= 640, `Send stays visible with eight images: ${JSON.stringify(action)}`);
	});

	for (const method of ["attach", "paste", "drop"] as const) {
		test(`composer content ${engine}: unreadable PNG via ${method} is refused without losing draft or other images`, { skip: engineSkip(engine) }, async (t) => {
			const page = await open(t, engine, type, path(), { route: ROUTE });
			await enableImageControl(page);
			const input = page.getByRole("textbox", { name: "Message the agent" });
			await input.fill("Keep this draft while refusing the unreadable image.");
			await page.locator('.composer input[type="file"]').setInputFiles({ name: "valid.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
			await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 1);
			const badFile = { name: "unreadable.png", mimeType: "image/png", buffer: Buffer.from("not an image") };
			if (method === "attach") {
				await page.locator('.composer input[type="file"]').setInputFiles(badFile);
			} else if (method === "drop") {
				await page.locator(".composer-wrap").evaluate((element, file) => {
					const transfer = new DataTransfer();
					const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
					transfer.items.add(new File([bytes], file.name, { type: file.type }));
					element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
				}, { name: badFile.name, type: badFile.mimeType, base64: badFile.buffer.toString("base64") });
			} else {
				await input.evaluate((element, file) => {
					const transfer = new DataTransfer();
					const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
					transfer.items.add(new File([bytes], file.name, { type: file.type }));
					element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
				}, { name: badFile.name, type: badFile.mimeType, base64: badFile.buffer.toString("base64") });
			}
			await page.waitForFunction(() => document.querySelector(".composer [role=alert]")?.textContent?.includes("unreadable.png isn't a readable image"), undefined, { timeout: 3_000 });
			const alert = page.locator(".composer [role=alert]");
			assert.match(await alert.innerText(), /unreadable\.png isn't a readable image, so it was not attached\./);
			assert.equal(await input.inputValue(), "Keep this draft while refusing the unreadable image.");
			assert.equal(await page.locator(".attachment").count(), 1, "the valid image remains attached");
			assert.equal(await page.locator('.attachment[title="valid.png"]').count(), 1);
		});
	}

	test(`composer content ${engine}: valid PNG admission remains fast`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE });
		await enableImageControl(page);
		const started = Date.now();
		await page.locator('.composer input[type="file"]').setInputFiles({ name: "valid.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
		await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 1);
		const elapsedMs = Date.now() - started;
		console.log(`valid PNG admission ${engine}: ${elapsedMs} ms`);
		assert.ok(elapsedMs < 1_000, `valid PNG admission took ${elapsedMs} ms`);
	});

	test(`composer content ${engine}: a single image beyond the limit is rejected`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE });
		await enableImageControl(page);
		const bytes = Math.ceil(CONTENT_OVERSIZE_IMAGE_BASE64 * 3 / 4);
		await page.locator(".composer-wrap").evaluate((element, { bytes, base64 }: { bytes: number; base64: string }) => {
			const data = new Uint8Array(bytes);
			data.set(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
			const transfer = new DataTransfer();
			transfer.items.add(new File([data], "oversize.png", { type: "image/png" }));
			element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		}, { bytes, base64: PNG });
		await page.getByRole("alert").waitFor();
		assert.equal(await page.locator(".attachment").count(), 0);
		assert.match(await page.getByRole("alert").innerText(), /over .* in total per message/);
		assert.match(await page.getByRole("alert").innerText(), /Remove an image or send it in a separate message\./, "the error says how to continue");
	});
}
