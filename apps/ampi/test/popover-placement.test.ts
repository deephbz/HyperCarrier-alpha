import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSocketRoute } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { slashCommandSlots } from "../web/src/slash-command-slots.ts";

type Outcome = "ready" | "no_control" | "error" | "version_skew";
type Rows = { name: string; top: number; left: number; bottom: number; selected: boolean }[];

/** Hold the real composer request so the test can measure loading, then release one chosen reply. */
function delayedCommands(commandCount = 3) {
	const pending: (() => void)[] = [];
	let outcome: Outcome = "ready";
	return {
		beforeNavigate(page: import("playwright").Page) {
			void page.routeWebSocket("**/ws", (client: WebSocketRoute) => {
				const server = client.connectToServer();
				client.onMessage((raw) => {
					const frame = JSON.parse(String(raw));
					if (frame.t === "req" && frame.op === "thread.commands") {
						pending.push(() => {
							if (outcome === "ready") client.send(JSON.stringify({ t: "res", id: frame.id, ok: true, value: { commands: commandList(commandCount), models: [], model: "synthetic/offline", thinkingLevels: ["off"] } }));
							else client.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: outcome === "no_control"
								? { code: "no_control", message: "This Session has no live control socket" }
								: outcome === "version_skew" ? { code: "version_skew", message: "The Pi control extension needs an update before AmPi can list commands" }
									: { code: "synthetic_failure", message: "Synthetic command-list failure" } }));
						});
						return;
					}
					server.send(raw);
				});
				server.onMessage((raw) => {
					const frame = JSON.parse(String(raw));
					if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as { control?: boolean }[]) thread.control = true;
					client.send(JSON.stringify(frame));
				});
			});
		},
		release(result: Outcome) {
			outcome = result;
			for (const reply of pending.splice(0)) reply();
		},
	};
}

function commandList(commandCount: number) {
	return Array.from({ length: commandCount }, (_, i) => ({ name: `cmd-${String(i).padStart(2, "0")}`, source: "builtin" as const, supported: true }));
}

test("supported Pi commands fill stable local-name slots without taking local dispatch", () => {
	const localRuns: string[] = [];
	const local = ["A", "B"].map((name) => ({ name, help: `local ${name}`, run: () => { localRuns.push(name); } }));
	const remote = [
		{ name: "X", source: "builtin" as const, supported: true, description: "remote X" },
		{ name: "A", source: "extension" as const, supported: true, description: "remote A", argsHint: "<arg>" },
	];
	const rows = slashCommandSlots(local, remote, { name: "stop", help: "Interrupt" }, "Unsupported");
	assert.deepEqual(rows.map((row) => row.name), ["stop", "A", "B", "X"]);
	assert.equal(rows[1]?.help, "remote A");
	assert.equal(rows[1]?.args, "<arg>");
	assert.equal(rows[1]?.run, undefined, "supported remote row uses typed Host dispatch, not the local callback");
	assert.deepEqual(localRuns, [], "building remote slot metadata does not run the local action");
});

async function visibleRows(page: import("playwright").Page): Promise<Rows> {
	return page.locator("[data-slash-menu]").evaluate((menu: HTMLElement) => {
		const bounds = menu.querySelector<HTMLElement>(".slash-options")!.getBoundingClientRect();
		return [...menu.querySelectorAll<HTMLElement>("[role=option]")].flatMap((row) => {
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) return [];
			return [{ name: row.querySelector("code")?.textContent ?? "", top: rect.top, left: rect.left, bottom: rect.bottom, selected: row.getAttribute("aria-selected") === "true" }];
		});
	});
}

async function waitForFinal(page: import("playwright").Page, result: Outcome) {
	await page.waitForFunction((result) => {
		const menu = document.querySelector<HTMLElement>("[data-slash-menu]");
		const foot = menu?.querySelector<HTMLElement>(".slash-foot");
		if (!menu || foot?.textContent?.toLowerCase().includes("loading")) return false;
		if (result === "ready") return menu.querySelectorAll("[role=option]").length > 1 && !foot?.hasAttribute("data-commands-hint");
		if (result === "no_control") return foot?.textContent?.includes("No control socket");
		return result === "version_skew" ? foot?.textContent?.includes("needs an update") : foot?.textContent?.includes("Synthetic command-list failure");
	}, result);
}

async function assertAppliedZoom(page: import("playwright").Page, expected: string, label: string) {
	const applied = await page.evaluate(() => getComputedStyle(document.documentElement).zoom);
	assert.equal(applied, expected, `${label}: App applies document zoom ${expected}`);
}

async function waitForLoading(page: import("playwright").Page) {
	await page.waitForFunction(() => document.querySelector("[data-commands-hint]")?.textContent?.toLowerCase().includes("loading"));
	const loading = await page.locator("[data-commands-hint]").textContent();
	const heldFrames = await page.evaluate(async () => {
		const sample = () => new Promise<string>((resolve) => requestAnimationFrame(() => resolve(document.querySelector("[data-commands-hint]")?.textContent ?? "")));
		return [await sample(), await sample(), await sample()];
	});
	assert.deepEqual(heldFrames, [loading, loading, loading], "command reply remains held for three animation frames");
	return loading;
}

async function visibleHit(page: import("playwright").Page, row: import("playwright").Locator) {
	const bounds = await row.boundingBox();
	if (!bounds) return false;
	return page.evaluate(({ x, y }) => {
		const option = document.elementFromPoint(x, y)?.closest<HTMLElement>("[role=option]");
		return Boolean(option && option.getAttribute("aria-selected") === "true");
	}, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
}

async function optionClip(page: import("playwright").Page, row: import("playwright").Locator) {
	return row.evaluate((el: HTMLElement) => {
		const r = el.getBoundingClientRect();
		let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
		for (let parent = el.parentElement; parent; parent = parent.parentElement) {
			const style = getComputedStyle(parent);
			if (!/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) continue;
			const p = parent.getBoundingClientRect();
			left = Math.max(left, p.left); top = Math.max(top, p.top);
			right = Math.min(right, p.right); bottom = Math.min(bottom, p.bottom);
		}
		return { row: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, clip: { left, top, right, bottom } };
	});
}

function assertRowsStay(rowsBefore: Rows, rowsAfter: Rows, label: string) {
	for (const before of rowsBefore) {
		const after = rowsAfter.find((row) => row.name === before.name);
		assert.ok(after, `${label}: shown row ${before.name} remains visible`);
		assert.ok(Math.abs(after.top - before.top) <= 0.5 && Math.abs(after.left - before.left) <= 0.5,
			`${label}: ${before.name} stays in place: (${before.left},${before.top}) -> (${after.left},${after.top})`);
		assert.equal(after.selected, before.selected, `${label}: ${before.name} keeps selection`);
	}
	const selectedBefore = rowsBefore.find((row) => row.selected);
	const selectedAfter = rowsAfter.find((row) => row.selected);
	assert.equal(selectedAfter?.name, selectedBefore?.name, `${label}: selected command stays selected`);
	assert.ok(selectedBefore && selectedAfter && Math.abs(selectedAfter.top - selectedBefore.top) <= 0.5,
		`${label}: selected row stays in place`);
}

for (const [engine, type, path] of ENGINES) {

	test(`popover placement ${engine}: repeated placement waits for settled content and a fixed anchor`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-long-title" });
		const composer = page.getByRole("textbox", { name: "Message the agent", exact: true });
		const menu = page.locator("[data-slash-menu]");
		const box = () => menu.evaluate((el: HTMLElement) => [el.style.left, el.style.top, el.style.width, el.style.maxWidth, el.style.maxHeight].join(" "));
		for (const zoom of ["1", "0.8", "1.3"]) {
			await page.evaluate((zoom) => { document.documentElement.style.zoom = zoom; }, zoom);
			await composer.fill("");
			await composer.fill("/");
			await menu.waitFor();
			await assertAppliedZoom(page, zoom, `placement zoom ${zoom}`);
			await page.waitForFunction(() => !document.querySelector("[data-commands-hint]")?.textContent?.toLowerCase().includes("loading"));
			const anchor = await composer.evaluate((el: HTMLElement) => {
				const r = el.parentElement!.getBoundingClientRect();
				return [r.left, r.top, r.right, r.bottom];
			});
			await page.evaluate(() => window.dispatchEvent(new Event("resize")));
			const first = await box();
			for (const left of ["0px", "3.3px", "700px"]) {
				await menu.evaluate((el: HTMLElement, left) => {
					Object.assign(el.style, { left, width: "37.7px", maxWidth: "50px", maxHeight: "40px" });
					window.dispatchEvent(new Event("resize"));
				}, left);
				const after = await composer.evaluate((el: HTMLElement) => {
					const r = el.parentElement!.getBoundingClientRect();
					return [r.left, r.top, r.right, r.bottom];
				});
				assert.deepEqual(after, anchor, `zoom ${zoom}, last left ${left}: anchor remains fixed`);
				assert.equal(await box(), first, `zoom ${zoom}, last left ${left}`);
			}
		}
	});

	for (const mobile of [false, true]) {
		for (const result of ["ready", "no_control", "error", "version_skew"] as const) {
			test(`slash menu ${engine} ${mobile ? "phone320" : "desktop"} zoom1.3 loading -> ${result} keeps shown rows`, { skip: engineSkip(engine) }, async (t) => {
				const delayed = delayedCommands();
				const page = await open(t, engine, type, path(), {
					route: "#/h/devbox/t/pi%3Asess-long-title",
					display: { overall: 1.3 },
					beforeNavigate: delayed.beforeNavigate,
					...(mobile ? { context: { isMobile: true, hasTouch: true, deviceScaleFactor: 2, viewport: { width: 320, height: 844 } } } : {}),
				});
				await page.reload();
				const input = page.getByRole("textbox", { name: "Message the agent", exact: true });
				await input.click();
				await input.press("/");
				const menu = page.locator("[data-slash-menu]");
				await menu.waitFor();
				await assertAppliedZoom(page, "1.3", `${engine} ${mobile ? "phone" : "desktop"} ${result}`);
				const loadingLabel = await waitForLoading(page);
				const anchorBefore = await page.locator(".composer-wrap").evaluate((el: HTMLElement) => {
					const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom];
				});
				const rowsBefore = await visibleRows(page);
				assert.ok(rowsBefore.length > 0, "loading state shows an option row");
				const initialMenu = await menu.evaluate((el: HTMLElement) => {
					const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height };
				});
				// Control: re-place while the response is still held. No shown row should move.
				await page.evaluate(() => window.dispatchEvent(new Event("resize")));
				assertRowsStay(rowsBefore, await visibleRows(page), `${result} held control`);
				delayed.release(result);
				await waitForFinal(page, result);
				const rowsAfter = await visibleRows(page);
				const anchorAfter = await page.locator(".composer-wrap").evaluate((el: HTMLElement) => {
					const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom];
				});
				const bounds = await menu.evaluate((el: HTMLElement) => {
					const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, height: r.height };
				});
				const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
				assert.ok(bounds.top >= 0 && bounds.left >= 0 && bounds.right <= viewport.width && bounds.bottom <= viewport.height, "menu stays inside viewport");
				assert.ok(Math.abs(bounds.height - initialMenu.height) <= 0.5, "fixed menu height stays within 0.5 px while commands resolve");
				assert.deepEqual(anchorAfter, anchorBefore, "composer anchor does not move");
				assert.equal(loadingLabel, "Loading commands from Pi…", "loading footer uses the stable command-loading label");
				assertRowsStay(rowsBefore, rowsAfter, `${result} resolved`);
				const visibleTranscript = await page.locator('[data-region="transcript"]').evaluate((el: HTMLElement, menuTop: number) => {
					const r = el.getBoundingClientRect(); return Math.max(0, Math.min(r.bottom, menuTop) - r.top) / r.height;
				}, bounds.top);
				assert.ok(visibleTranscript >= 0.55, `at least 55% of the transcript remains visible: ${visibleTranscript}`);
				console.log(JSON.stringify({ engine, mobile, result, initialMenu, finalMenu: bounds, visibleTranscript, rowsBefore, rowsAfter }));
			});
		}
	}

	test(`slash menu ${engine} flips below when resized above the composer`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-long-title", display: { overall: 1.3 } });
		const input = page.getByRole("textbox", { name: "Message the agent", exact: true });
		await input.click();
		await input.press("/");
		const menu = page.locator("[data-slash-menu]");
		await menu.waitFor();
		await assertAppliedZoom(page, "1.3", `${engine} side flip`);
		const before = await menu.boundingBox();
		const owner = page.locator(".composer");
		const anchorBefore = await owner.boundingBox();
		assert.ok(before && anchorBefore && before.y < anchorBefore.y, "menu initially opens above the composer");
		await owner.evaluate((el: HTMLElement) => Object.assign(el.style, { position: "fixed", top: "60px", bottom: "auto", left: "0", right: "0" }));
		await page.evaluate(() => window.dispatchEvent(new Event("resize")));
		const after = await menu.boundingBox();
		const anchorAfter = await owner.boundingBox();
		assert.ok(after && anchorAfter && after.y >= anchorAfter.y + anchorAfter.height, `menu flips below the moved composer: ${JSON.stringify({ after, anchorAfter })}`);
	});

	test(`slash menu ${engine} phone320 Escape restores the newest entry`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), {
			route: "#/h/devbox/t/pi%3Asess-long-title",
			context: { isMobile: true, hasTouch: true, deviceScaleFactor: 2, viewport: { width: 320, height: 844 } },
			display: { overall: 1.3 },
		});
		await page.reload();
		const input = page.getByRole("textbox", { name: "Message the agent", exact: true });
		const newest = page.locator(".transcript [data-entry]").last();
		const transcript = page.locator('[data-region="transcript"]');
		const before = await newest.boundingBox();
		await input.click();
		await input.press("/");
		await page.locator("[data-slash-menu]").waitFor();
		await assertAppliedZoom(page, "1.3", `${engine} Escape`);
		await input.press("Escape");
		await page.locator("[data-slash-menu]").waitFor({ state: "detached" });
		const after = await newest.boundingBox();
		const bounds = await transcript.boundingBox();
		assert.ok(before && after && bounds && after.y >= bounds.y && after.y + after.height <= bounds.y + bounds.height, "Escape leaves the whole newest entry visible");
		assert.deepEqual(after, before, "Escape does not move the newest entry");
	});

	for (const result of ["ready", "no_control", "error", "version_skew"] as const) {
		test(`slash menu ${engine} phone320x480 ${result} keeps footer and initial wrapped /stop visible`, { skip: engineSkip(engine) }, async (t) => {
			const delayed = delayedCommands(40);
			const page = await open(t, engine, type, path(), {
				route: "#/h/devbox/t/pi%3Asess-long-title",
				beforeNavigate: delayed.beforeNavigate,
				context: { isMobile: true, hasTouch: true, deviceScaleFactor: 2, viewport: { width: 320, height: 480 } },
				display: { overall: 1.3 },
			});
			await page.reload();
			const input = page.getByRole("textbox", { name: "Message the agent", exact: true });
			await input.click();
			await input.press("/");
			const menu = page.locator("[data-slash-menu]");
			await menu.waitFor();
			await assertAppliedZoom(page, "1.3", `${engine} phone320x480 ${result}`);
			await waitForLoading(page);
			const stop = page.locator('[role="option"]').filter({ hasText: "/stop" }).first();
			const footer = page.locator(".slash-foot");
			const assertFooter = async (state: string) => {
				const foot = await footer.evaluate((el: HTMLElement) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
				assert.ok(foot.scroll <= foot.client, `${state}: footer has no hidden inner scroll: ${JSON.stringify(foot)}`);
			};
			await assertFooter("loading");
			const before = await stop.boundingBox();
			delayed.release(result);
			await waitForFinal(page, result);
			await assertFooter(result);
			const after = await stop.boundingBox();
			const actualClip = await optionClip(page, stop);
			assert.ok(actualClip.row.top >= actualClip.clip.top - 0.5 && actualClip.row.bottom <= actualClip.clip.bottom + 0.5, `${result}: complete selected /stop fits every ancestor clip: ${JSON.stringify(actualClip)}`);
			const wholeMenu = await menu.evaluate((el: HTMLElement) => ({ scroll: el.scrollHeight, client: el.clientHeight, top: el.scrollTop }));
			assert.ok(wholeMenu.scroll > wholeMenu.client, `${result}: short-screen footer and selected row use whole-menu scrolling`);
			await menu.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
			const [footBounds, menuBounds] = await Promise.all([footer.boundingBox(), menu.boundingBox()]);
			assert.ok(footBounds && menuBounds && footBounds.y < menuBounds.y + menuBounds.height && footBounds.y + footBounds.height > menuBounds.y, `${result}: whole-menu scroll exposes the footer: ${JSON.stringify({ footBounds, menuBounds, wholeMenu, scrollTop: await menu.evaluate((el: HTMLElement) => el.scrollTop) })}`);
			await menu.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
			await input.press("ArrowDown");
			await input.press("ArrowUp");
			const keyboardClip = await optionClip(page, stop);
			assert.ok(keyboardClip.row.top >= keyboardClip.clip.top - 0.5 && keyboardClip.row.bottom <= keyboardClip.clip.bottom + 0.5, `${result}: complete keyboard-selected row fits every ancestor clip: ${JSON.stringify(keyboardClip)}`);
			assert.ok(before && after && Math.abs(before.y - after.y) <= 0.5, `${result}: /stop stays top-anchored when footer height changes`);
		});

		test(`slash menu ${engine} phone320x480 -> 320x240 ${result} caps row floor and keeps menu above composer`, { skip: engineSkip(engine) }, async (t) => {
			const delayed = delayedCommands(40);
			const page = await open(t, engine, type, path(), {
				route: "#/h/devbox/t/pi%3Asess-long-title",
				beforeNavigate: delayed.beforeNavigate,
				context: { isMobile: true, hasTouch: true, deviceScaleFactor: 2, viewport: { width: 320, height: 480 } },
				display: { overall: 1.3 },
			});
			await page.reload();
			const input = page.getByRole("textbox", { name: "Message the agent", exact: true });
			await input.click();
			await input.press("/");
			const menu = page.locator("[data-slash-menu]");
			await menu.waitFor();
			await assertAppliedZoom(page, "1.3", `${engine} shrink ${result}`);
			await waitForLoading(page);
			delayed.release(result);
			await waitForFinal(page, result);
			await page.setViewportSize({ width: 320, height: 240 });
			await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
			const [bounds, anchor, scroll] = await Promise.all([
				menu.boundingBox(),
				page.locator(".composer").boundingBox(),
				menu.evaluate((el: HTMLElement) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, min: el.style.minHeight, max: el.style.maxHeight, whole: el.classList.contains("slash-menu-whole-scroll") })),
			]);
			assert.ok(bounds && anchor, "menu and composer remain measurable after viewport shrink");
			assert.ok(bounds.y >= 11.5 && bounds.y + bounds.height <= anchor.y - 7.5 && bounds.y + bounds.height <= 240, `menu stays within the available room above composer: ${JSON.stringify({ bounds, anchor, scroll })}`);
			assert.ok(scroll.whole && scroll.height > scroll.client, `small viewport makes the whole menu the scroller: ${JSON.stringify(scroll)}`);
			const stop = page.locator('[role="option"][aria-selected="true"]');
			await menu.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
			const row = await stop.boundingBox(), menuTop = await menu.boundingBox();
			assert.ok(row && menuTop && row.y < menuTop.y + menuTop.height && row.y + row.height > menuTop.y, `whole-menu scrolling reaches the selected row: ${JSON.stringify({ row, menuTop })}`);
			await menu.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
			const footer = await page.locator(".slash-foot").boundingBox(), menuBottom = await menu.boundingBox();
			assert.ok(footer && menuBottom && footer.y < menuBottom.y + menuBottom.height && footer.y + footer.height > menuBottom.y, `whole-menu scrolling reaches the footer: ${JSON.stringify({ footer, menuBottom })}`);
		});
	}

	test(`slash menu ${engine} phone320x844 long list preserves selection and scroll ownership`, { skip: engineSkip(engine) }, async (t) => {
		const delayed = delayedCommands(40);
		const page = await open(t, engine, type, path(), {
			route: "#/h/devbox/t/pi%3Asess-long-title",
			beforeNavigate: delayed.beforeNavigate,
			context: { isMobile: true, hasTouch: true, deviceScaleFactor: 2, viewport: { width: 320, height: 844 } },
			display: { overall: 1.3 },
		});
		await page.reload();
		const input = page.getByRole("textbox", { name: "Message the agent", exact: true });
		await input.click();
		await input.press("/");
		const menu = page.locator("[data-slash-menu]");
		await menu.waitFor();
		await assertAppliedZoom(page, "1.3", `${engine} phone320x844`);
		const loadingLabel = await waitForLoading(page);
		const rowsBefore = await visibleRows(page);
		assert.ok(rowsBefore.length > 0, "loading shows a selected option");
		const initialStop = page.locator('[role="option"][aria-selected="true"]');
		const initialStopBounds = await initialStop.boundingBox();
		const initialOptions = page.locator(".slash-options");
		const initialOptionsBounds = await initialOptions.boundingBox();
		assert.ok(initialStopBounds && initialOptionsBounds && initialStopBounds.y >= initialOptionsBounds.y - 0.5 && initialStopBounds.y + initialStopBounds.height <= initialOptionsBounds.y + initialOptionsBounds.height + 0.5, `initial selected /stop is fully inside the options clip: ${JSON.stringify({ initialStopBounds, initialOptionsBounds })}`);
		const beforeAsyncScroll = await page.evaluate(() => ({ page: window.scrollY, transcript: document.querySelector<HTMLElement>('[data-region="transcript"]')?.scrollTop }));
		delayed.release("ready");
		await waitForFinal(page, "ready");
		assert.deepEqual(await page.evaluate(() => ({ page: window.scrollY, transcript: document.querySelector<HTMLElement>('[data-region="transcript"]')?.scrollTop })), beforeAsyncScroll, "async list replacement does not reveal or scroll");
		const rowsAfter = await visibleRows(page);
		assertRowsStay(rowsBefore, rowsAfter, "long list resolved");
		assert.equal(loadingLabel, "Loading commands from Pi…", "loading footer uses the stable command-loading label");
		const bounds = await menu.evaluate((el: HTMLElement) => {
			const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, height: r.height, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
		});
		const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
		assert.ok(bounds.top >= 0 && bounds.left >= 0 && bounds.right <= viewport.width && bounds.bottom <= viewport.height, "bounded at viewport edges");
		const options = page.locator(".slash-options");
		const scroll = await options.evaluate((el: HTMLElement) => ({ top: el.scrollTop, client: el.clientHeight, height: el.scrollHeight }));
		assert.ok(scroll.height > scroll.client, "long list scrolls inside the option region");
		await options.evaluate((el: HTMLElement) => { el.scrollTop = 200; });
		const beforeHoverScroll = await options.evaluate((el: HTMLElement) => el.scrollTop);
		await page.setViewportSize({ width: 320, height: 864 });
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const afterRealResize = await options.evaluate((el: HTMLElement) => ({ scrollTop: el.scrollTop, height: el.clientHeight, scrollHeight: el.scrollHeight }));
		assert.ok(Math.abs(afterRealResize.scrollTop - beforeHoverScroll) <= 1, `real 320x844 to 320x864 resize over two frames preserves manual options scroll within WebKit's 1 px scrollTop quantization: ${JSON.stringify({ beforeHoverScroll, afterRealResize, whole: await menu.evaluate((el: HTMLElement) => el.classList.contains("slash-menu-whole-scroll")) })}`);
		const visibleCmd = await page.evaluate(() => {
			const clip = document.querySelector<HTMLElement>(".slash-options")!.getBoundingClientRect();
			const inside = [...document.querySelectorAll<HTMLElement>("[role=option]")]
				.map((el) => ({ text: el.querySelector("code")?.textContent ?? "", rect: el.getBoundingClientRect() }))
				.filter(({ text, rect }) => /^\/cmd-\d+$/.test(text) && rect.top >= clip.top + 1 && rect.bottom <= clip.bottom - 1);
			return inside[Math.floor(inside.length / 2)]?.text ?? null;
		});
		assert.ok(visibleCmd, "a synthetic command sits fully inside the scrolled options viewport");
		const visibleNumber = Number(visibleCmd.slice("/cmd-".length));
		const nextCmd = `/cmd-${String(visibleNumber + 1).padStart(2, "0")}`;
		await page.getByRole("option", { name: new RegExp(visibleCmd.slice(1)) }).hover();
		assert.equal(await page.locator('[role="option"][aria-selected="true"] code').textContent() ?? "", visibleCmd, "hover changes selection after manual menu scroll");
		assert.ok(Math.abs(await options.evaluate((el: HTMLElement) => el.scrollTop) - afterRealResize.scrollTop) <= 1, "app rerender from hover preserves manual menu scroll");
		assert.ok(Math.abs(await options.evaluate((el: HTMLElement) => el.scrollTop) - afterRealResize.scrollTop) <= 1, "selection change on a visible row preserves manual menu scroll");
		const beforeArrowScroll = await page.evaluate(() => ({ page: window.scrollY, transcript: document.querySelector<HTMLElement>('[data-region="transcript"]')?.scrollTop }));
		await input.press("ArrowDown");
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const selected = page.locator('[role="option"][aria-selected="true"]');
		assert.equal(await selected.locator("code").textContent() ?? "", nextCmd, "ArrowDown selects the command after the hovered row");
		const selectedClip = await optionClip(page, selected);
		assert.ok(selectedClip.row.top >= selectedClip.clip.top - 0.5 && selectedClip.row.bottom <= selectedClip.clip.bottom + 0.5, `selected row fits every ancestor clip: ${JSON.stringify({ selectedClip, scroll: await options.evaluate((el: HTMLElement) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight })) })}`);
		assert.deepEqual(await page.evaluate(() => ({ page: window.scrollY, transcript: document.querySelector<HTMLElement>('[data-region="transcript"]')?.scrollTop })), beforeArrowScroll, "selection reveal does not scroll the page or transcript");
		await options.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
		const final = page.getByRole("option", { name: /cmd-39/ });
		await final.hover();
		assert.match(await page.locator('[role="option"][aria-selected="true"] code').textContent() ?? "", /cmd-39/, "hover selects the final command by identity");
		await page.setViewportSize({ width: 320, height: 520 });
		await page.evaluate(() => { document.documentElement.style.zoom = "1.1"; window.dispatchEvent(new Event("resize")); });
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		assert.match(await page.locator('[role="option"][aria-selected="true"] code').textContent() ?? "", /cmd-39/, "resize and zoom preserve selected command identity");
		await input.press("ArrowDown");
		await input.press("ArrowUp");
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const target = await final.boundingBox();
		assert.ok(target, "final command has a hit target after keyboard reveal");
		const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[role=option]")?.querySelector("code")?.textContent, { x: target!.x + target!.width / 2, y: target!.y + target!.height / 2 });
		assert.equal(hit, "/cmd-39", "final command is the visible hit target after keyboard reveal");
		await final.click();
		assert.equal(await input.inputValue(), "/cmd-39", "clicking the final command selects that command identity");

	});
}
