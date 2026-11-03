import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import { stamp } from "../src/shared/build.ts";
import { CONTENT_FIND_QUERY } from "../scripts/demo/data/content-transcript.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

const ROUTE = "#/h/devbox/t/pi%3Asess-content-worst";

async function hubFind(page: import("playwright").Page, query: string) {
	const pageUrl = new URL(page.url());
	const socket = new WebSocket(`ws://${pageUrl.host}/ws`, { headers: { authorization: `Bearer ${pageUrl.searchParams.get("k")}` } });
	const started = performance.now();
	return new Promise<{ elapsedMs: number; value: Record<string, unknown> }>((resolve, reject) => {
		socket.on("open", () => {
			socket.send(JSON.stringify({ t: "hello", build: stamp().id }));
			socket.send(JSON.stringify({ t: "req", id: 1, host: "devbox", op: "thread.find", args: { threadId: "pi:sess-content-worst", query } }));
		});
		socket.on("message", (data) => {
			const frame = JSON.parse(String(data));
			if (frame.t !== "res" || frame.id !== 1) return;
			socket.close();
			if (!frame.ok) reject(new Error(frame.error?.message ?? "Hub Find failed"));
			else resolve({ elapsedMs: performance.now() - started, value: frame.value });
		});
		socket.on("error", reject);
	});
}

for (const [engine, type, path] of ENGINES) {
	test(`Find content ${engine}: 500-character query and 220 hits remain usable at 320 px`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE, fixture: "worst" });
		await page.getByRole("button", { name: "Close panel" }).click();
		await page.setViewportSize({ width: 320, height: 800 });
		const normal = await hubFind(page, "Find boundary");
		const worst = await hubFind(page, CONTENT_FIND_QUERY);
		console.log(`hub-only Find ${engine}: normal ${normal.elapsedMs.toFixed(1)} ms (${(normal.value.hits as unknown[])?.length} hits), 500 chars ${worst.elapsedMs.toFixed(1)} ms (${(worst.value.hits as unknown[])?.length} hits), scanned ${worst.value.scanned}, total ${worst.value.total}`);
		assert.equal((worst.value.hits as unknown[]).length, 200);
		assert.equal(worst.value.total, 220);
		await page.getByRole("button", { name: "Find in this Session" }).click();
		const input = page.getByRole("textbox", { name: "Find in Session" });
		const status = page.locator(".find-bar [role=status]");
		for (const query of ["Find boundary", CONTENT_FIND_QUERY]) {
			await input.fill(query);
			await page.waitForFunction(() => document.querySelector(".find-bar [role=status]")?.textContent === "…");
			await page.waitForFunction(() => /\d+ \/ 220/.test(document.querySelector(".find-bar [role=status]")?.textContent ?? ""));
		}
		assert.equal((await input.inputValue()).length, 500);
		await page.getByRole("button", { name: "Filter" }).click();
		await page.locator(".find-hit").first().waitFor();
		assert.equal(await page.locator(".find-hit").count(), 200);
		assert.equal(await page.locator(".find-more").count(), 1);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Find does not scroll the page sideways");
		assert.equal(await page.getByRole("button", { name: "Next match" }).isEnabled(), true);
	});
}
