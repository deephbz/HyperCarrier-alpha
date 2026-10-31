import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAP, frames, newButton, open, view } from "./thread-scroll-fixture.ts";

// A split entry's fragment in a frozen window (see thread-scroll-frozen.test.ts) keeps its place across downward
// extensions and trims, with and without the conversation-only lens.

/** Entries e{from}..e{n-1}, all assistant: prose, a tool call, and prose after the tool. No entry id paints only once. */
const splitWindow = (n: number, from: number) => ({ ...view(n, "", from), hiddenBefore: from > 0, entries: Array.from({ length: n - from }, (_, k) => {
	const id = `e${from + k}`;
	return { id, kind: "assistant", blocks: [
		{ type: "text", text: `Answer ${id}. ${"Details. ".repeat(4 + (k % 5) * 4)}` },
		{ type: "tool", callId: `split-${id}`, name: "bash", args: { command: "pwd" } },
		{ type: "text", text: `After tool ${id}. ${"More details. ".repeat(4 + (k % 3) * 6)}` },
	] };
}) });
for (const [backend, lens] of [["pi", false], ["pi", true]] as const) {
	for (const place of ["at the clamped bottom", "inside the extension band"] as const) {
		test(`scroll hold: ${backend}${lens ? " conversation-only" : ""}, a downward extension keeps a read after-tool fragment ${place} in place`, async (t) => {
			const { page, send } = await open(t, CAP, backend);
			send(splitWindow(CAP, 0));
			await page.locator("[data-region=transcript] .md", { hasText: `After tool e${CAP - 1}.` }).waitFor({ state: "attached" });
			await frames(page);
			if (lens) {
				await page.getByRole("button", { name: "Chat", exact: true }).click();
				await page.locator('[aria-label="Transcript mode"] > [aria-pressed="true"]', { hasText: "Chat" }).first().waitFor({ state: "attached" });
				await frames(page);
			}
			await page.evaluate(() => { document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop = 300; });
			await frames(page);
			await page.waitForTimeout(100);
			// 960 arrivals in source windows of the cap: the source moves past every frozen row.
			for (let n = CAP + 120; n <= CAP + 960; n += 120) {
				send(splitWindow(n, n - CAP));
				await newButton(page).waitFor();
				await page.waitForTimeout(30);
				await frames(page);
			}
			// The reader reads an after-tool fragment near the frozen bottom: the last one lands clamped at the bottom; a reader
			// 300 px above the bottom stays inside the 600 px extension band without a clamp.
			const before = await page.evaluate((clamped) => {
				const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
				const fragments = () => [...el.querySelectorAll<HTMLElement>(".md")].filter((node) => node.textContent!.startsWith("After tool"));
				if (clamped) { const node = fragments().at(-1)!; el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 20; }
				else el.scrollTop = el.scrollHeight - el.clientHeight - 300;
				const top = el.getBoundingClientRect().top;
				const node = fragments().find((node) => node.getBoundingClientRect().top >= top)!;
				return { text: node.textContent!.split(".")[0] + ".", offset: node.getBoundingClientRect().top - top, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
			}, place === "at the clamped bottom");
			const text = before.text;
			if (place === "at the clamped bottom") assert.ok(before.gap <= 1, `the reader is clamped at the frozen bottom: gap ${before.gap}`);
			else assert.ok(before.gap > 1 && before.gap < 600, `the reader is inside the band and not clamped: gap ${before.gap}`);
			await page.locator(".omitted").waitFor({ state: "attached" });
			await page.waitForTimeout(30);
			await frames(page);
			const after = await page.locator("[data-region=transcript] .md").filter({ hasText: text }).evaluate((node) => node.getBoundingClientRect().top - document.querySelector<HTMLElement>("[data-region=transcript]")!.getBoundingClientRect().top);
			assert.ok(Math.abs(after - before.offset) <= 2, `the extension moved "${text}" from ${before.offset.toFixed(1)} to ${after.toFixed(1)}`);
		});
	}
}
for (const [backend, lens] of [["pi", false], ["pi", true]] as const) {
	test(`scroll hold: ${backend}${lens ? " conversation-only" : ""}, a trim that drops the whole first segment keeps the read fragment`, async (t) => {
		const { page, send } = await open(t, CAP, backend);
		send(splitWindow(CAP, 0));
		await page.locator("[data-region=transcript] .md", { hasText: `After tool e${CAP - 1}.` }).waitFor({ state: "attached" });
		await frames(page);
		if (lens) {
			await page.getByRole("button", { name: "Chat", exact: true }).click();
			await page.locator('[aria-label="Transcript mode"] > [aria-pressed="true"]', { hasText: "Chat" }).first().waitFor({ state: "attached" });
			await frames(page);
		}
		await page.evaluate(() => { document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop = 300; });
		await frames(page);
		await page.waitForTimeout(100);
		for (let n = CAP + 120; n <= CAP + 960; n += 120) {
			send(splitWindow(n, n - CAP));
			await newButton(page).waitFor();
			await page.waitForTimeout(30);
			await frames(page);
		}
		// Three extensions below the divider after e399: the third trims every row of the first segment away.
		for (const next of [1079, 1199, 1319]) {
			const before = await page.evaluate(() => {
				const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
				const node = [...el.querySelectorAll<HTMLElement>(".md")].filter((node) => node.textContent!.startsWith("After tool")).at(-1)!;
				el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 20;
				(node as HTMLElement & { read?: boolean }).read = true;
				return { text: node.textContent!.split(".")[0] + ".", offset: node.getBoundingClientRect().top - el.getBoundingClientRect().top };
			});
			await page.locator("[data-region=transcript] .md", { hasText: `After tool e${next}.` }).waitFor({ state: "attached" });
			await page.waitForTimeout(30);
			await frames(page);
			const after = await page.locator("[data-region=transcript] .md").filter({ hasText: before.text }).evaluate((node) => ({
				offset: node.getBoundingClientRect().top - document.querySelector<HTMLElement>("[data-region=transcript]")!.getBoundingClientRect().top,
				same: Boolean((node as HTMLElement & { read?: boolean }).read),
			}));
			assert.ok(after.same, `the extension to e${next} remounted the read fragment "${before.text}"`);
			assert.ok(Math.abs(after.offset - before.offset) <= 2, `the extension to e${next} moved "${before.text}" from ${before.offset.toFixed(1)} to ${after.offset.toFixed(1)}`);
		}
		assert.equal(await page.locator("[data-region=transcript] .md", { hasText: "After tool e399." }).count(), 0, "the trim dropped the first segment");
	});
}
