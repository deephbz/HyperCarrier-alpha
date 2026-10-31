import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

// One focus authority: each route arrival makes one request, and the App focus adapter places it when the
// requested region mounts. A Session's regions mount after its data arrives; no region focuses itself on mount.
const THREAD = "pi:sess-big";
const region = (page: any) => page.evaluate(() => document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region ?? document.activeElement?.tagName);
const settled = async (page: any) => {
	await page.locator('[data-region="transcript"] [data-entry]').first().waitFor({ state: "attached" });
	await page.getByRole("textbox", { name: "Message the agent", exact: true }).waitFor();
	// A late self-focus would land within a few frames of the mount.
	await page.waitForTimeout(400);
};
/** Holds the Session's data `ms` so its transcript and composer mount after the route arrival. */
const hold = (page: any, ms: number) => page.routeWebSocket("**/ws", (ws: any) => {
	const server = ws.connectToServer();
	ws.onMessage((raw: string) => server.send(raw));
	server.onMessage((raw: string) => {
		const f = JSON.parse(String(raw));
		if (f.t === "snap" && f.value?.conversationId === THREAD) setTimeout(() => ws.send(raw), ms);
		else ws.send(raw);
	});
});
const reopen = async (page: any) => {
	await page.keyboard.press("ControlOrMeta+Digit0");
	await page.waitForURL(/#\/v\/overview/);
	await page.reload();
	await page.locator("[data-page-root]").waitFor();
	await page.locator(`.side .row[data-thread="${THREAD}"]`).first().click();
	await page.waitForURL((url: URL) => url.hash.endsWith(`/t/${encodeURIComponent(THREAD)}`));
};

for (const [engine, type, path] of ENGINES) test(`history focus ${engine}: arrivals focus the requested region while the Session mounts late`, { skip: engineSkip(engine) }, async (t) => {
	const page = await open(t, engine, type, path(), { route: `#/h/devbox/t/${encodeURIComponent(THREAD)}` });
	await hold(page, 600);
	const transcript = page.locator('[data-region="transcript"]');
	await transcript.click({ position: { x: 20, y: 120 } });
	assert.equal(await region(page), "transcript");
	const session = page.url();

	// Back after a reload: the entry held the transcript, so the transcript keeps focus after the composer mounts.
	await page.keyboard.press("ControlOrMeta+Digit0");
	await page.waitForURL(/#\/v\/overview/);
	await page.reload();
	await page.locator("[data-page-root]").waitFor();
	await page.evaluate(() => history.back());
	await page.waitForURL(session);
	await settled(page);
	assert.equal(await region(page), "transcript", "Back returns to the transcript; the late composer does not take it");

	// A new arrival opens the Session in its composer, though the composer mounts after the arrival.
	await reopen(page);
	await settled(page);
	assert.equal(await region(page), "composer", "a Session opens in its composer");
});

// The wait belongs to one arrival. While the composer is still missing, the transcript holds focus by the fallback;
// the reader's wheel or a later route arrival ends the wait, so the composer's late mount moves nothing.
for (const [engine, type, path] of ENGINES) test(`history focus ${engine}: a wheel or a later arrival ends the wait for a missing region`, { skip: engineSkip(engine) }, async (t) => {
	const page = await open(t, engine, type, path(), { route: `#/h/devbox/t/${encodeURIComponent(THREAD)}` });
	await hold(page, 1500);
	const transcript = page.locator('[data-region="transcript"]');
	for (const end of ["wheel", "arrival"] as const) {
		await reopen(page);
		await page.waitForFunction(() => document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region === "transcript", undefined, { timeout: 1000 });
		assert.equal(await page.locator('[data-region="composer"]').count(), 0, `${end}: the composer is still missing`);
		if (end === "wheel") {
			const box = (await transcript.boundingBox())!;
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.mouse.wheel(0, -200);
		} else await page.evaluate((hash) => { location.hash = hash; }, `#/h/devbox/t/${encodeURIComponent(THREAD)}?p=arc`);
		await settled(page);
		assert.equal(await region(page), "transcript", `${end}: the composer's late mount must not take focus`);
	}
});

test("no Session region focuses itself on mount; the App focus adapter places requested focus", () => {
	const composer = readFileSync(new URL("../web/src/components/Composer.tsx", import.meta.url), "utf8");
	for (const effect of composer.matchAll(/useEffect\(\(\) => \{([^]*?)\}, \[[^\]]*\]\);/g)) assert.doesNotMatch(effect[1]!, /\.focus\(/, `Composer focuses itself in an effect: ${effect[0].slice(0, 120)}`);
});
