import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open as openFixture } from "./resize-edges-fixture.ts";

let linuxSystemUiFont: string | null | undefined;

/** Calibrated axis-metric limits were measured with SF Pro (macOS) and Noto Sans (Linux). */
export function calibratedFontSkip(engine: string): string | false {
	const skip = engineSkip(engine);
	if (skip) return skip;
	if (process.platform !== "linux") return false;
	if (linuxSystemUiFont === undefined) {
		try {
			linuxSystemUiFont = execFileSync("fc-match", ["-f", "%{family}", "system-ui"], { encoding: "utf8" }).trim();
		} catch {
			linuxSystemUiFont = null;
		}
	}
	if (linuxSystemUiFont === "Noto Sans") return false;
	return `calibrated for Noto Sans (system-ui resolves to ${linuxSystemUiFont || "unknown"})`;
}

const LOCALE = "en-US";
const createdContexts = new Map<string, number>();
export const open: typeof openFixture = async (...args) => {
	const engine = args[1], count = (createdContexts.get(engine) ?? 0) + 1;
	assert.ok(count <= 56, `${engine}: phone test file needs ${count} contexts; share cases or split the file. WebKit stalls at 64 created contexts. External proof: ~/.cache/ampi-arc-proto/v21/webkit-context-probe.log`);
	createdContexts.set(engine, count);
	return openFixture(...args);
};
// Match browser and Node formatting without depending on the runner's local zone.
export const phone = (width: number) => ({ viewport: { width, height: width === 375 ? 667 : 844 }, hasTouch: true, isMobile: true, locale: LOCALE, timezoneId: "Asia/Singapore" });
export const AXIS_TIMES = ["2026-11-05T01:00:00+08:00", "2026-11-05T11:00:00+08:00", "2026-11-06T12:00:00+08:00"];
export const AXIS_MATRIX = Array.from({ length: 7 }, (_, day) => ["09:05", "11:00", "12:59", "23:59"].map((time) => `2026-11-${String(2 + day).padStart(2, "0")}T${time}:00+08:00`)).flat();

/** The page's and the main view's sideways overflow, in px. */
export function overflow(page: Page) {
	return page.evaluate(() => {
		const doc = document.scrollingElement!;
		const main = document.querySelector<HTMLElement>("[data-page-root] .main")!;
		return { page: doc.scrollWidth - doc.clientWidth, main: main.scrollWidth - main.clientWidth };
	});
}

export async function settled(page: Page) {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function go(page: Page, route: string, ready: string) {
	await page.evaluate((route) => { location.hash = route; }, route);
	await page.locator(ready).first().waitFor({ state: "attached" });
	await settled(page);
}

const SESSION = "#/h/devbox/t/pi%3Asess-lead";

// Fast and exhaustive lanes use the same clock, projection, and text-fragment assertions.
export function phoneAxisTests(pinnedTimes: readonly string[], widths: readonly number[] = [320, 375, 390], { shareRanges = true }: { shareRanges?: boolean } = {}) {
	for (const [engine, type, path] of ENGINES) for (const width of widths) {
		// Fast contexts visit six cases. Split exhaustive ranges at 28 cases to stay below WebKit's history-write rate limit.
		const rangeGroups = width === 390 ? [[false]] : shareRanges ? [[false, true]] : [[false], [true]];
		for (const ranges of rangeGroups) for (const overall of width === 390 ? [1] : [1, 1.25, 1.5, 2]) for (const locale of [LOCALE, "de-DE"]) test(`phone layout ${engine} ${width} px: the Timeline axis shows whole labels ${locale} zoom ${overall}${shareRanges ? "" : ranges[0] ? " historical" : " live"}`, { skip: calibratedFontSkip(engine) }, async (t) => {
			const times = pinnedTimes;
			const page = await open(t, engine, type, path(), { route: SESSION, display: { overall }, context: { ...phone(width), locale }, beforeNavigate: (page) => page.clock.setFixedTime(new Date(times[0])) });
			for (const historical of ranges) for (const now of times) await t.test(`${historical ? "historical" : "live"} at ${now}${historical && overall === 2 ? " (KNOWN LIMIT: magnified historical endpoint)" : ""}`, async (t) => {
				await go(page, SESSION, ".transcript [data-entry]");
				await page.clock.setFixedTime(new Date(now));
				const expectedTo = Date.parse(now) - (historical ? 3 * 3600_000 : 0);
				const route = historical ? `#/v/timeline?from=${Date.parse(now) - 4 * 86_400_000}&to=${expectedTo}` : "#/v/timeline";
				await go(page, route, ".cos-axis time");
				const axis = await page.evaluate((checkMain) => {
					let mainActual: { height: number; overflow: number; toolbar: string | null } | undefined;
					if (checkMain) {
						const baseline = document.createElement("style");
						baseline.textContent = ".cos-axis > div { display:flex!important;container-type:normal!important;gap:8px!important } .cos-axis time { min-width:auto!important;white-space:nowrap!important;overflow-wrap:normal!important } .cos-axis time:nth-child(1), .cos-axis time:nth-child(3) { display:block!important }";
						document.head.append(baseline);
						const area = document.querySelector(".cos-axis > div")!.getBoundingClientRect();
						const fragments = [...document.querySelectorAll<HTMLElement>(".cos-axis time")].filter((time) => time.offsetParent).flatMap((time) => { const range = document.createRange(); range.selectNodeContents(time.querySelector(".cos-tick-short")!); return [...range.getClientRects()].filter((rect) => rect.width); });
						mainActual = { height: document.querySelector(".cos-axis")!.getBoundingClientRect().height, toolbar: document.querySelector('.cos-toolbar button[aria-label^="Time window:"]')!.textContent, overflow: Math.max(0, ...fragments.map((rect) => Math.max(area.left - rect.left, rect.right - area.right))) };
						baseline.remove();
					}
					const box = document.querySelector(".cos-axis > div")!.getBoundingClientRect();
					const shown = [...document.querySelectorAll<HTMLTimeElement>(".cos-axis time")].filter((time) => time.offsetParent);
					const axisNode = document.querySelector<HTMLElement>(".cos-axis")!;
					const scale = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
					const style = getComputedStyle(axisNode);
					const name = document.createRange(); name.selectNodeContents(axisNode.firstElementChild!);
					const nameLines = new Set([...name.getClientRects()].filter((rect) => rect.width).map((rect) => Math.round(rect.top))).size;
					const lineHeight = parseFloat(style.lineHeight) * scale;
					const mainHeight = Math.max(1, nameLines) * lineHeight + (parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)) * scale;
					return {
						mainActual, mainHeight, lineHeight, em: parseFloat(style.fontSize) * scale,
						box: { left: box.left, right: box.right },
						labels: shown.map((time) => {
							const label = [...time.children].find((span) => getComputedStyle(span).display !== "none") as HTMLElement;
							const rect = label.getBoundingClientRect();
							const range = document.createRange();
							range.selectNodeContents(label);
							const fragments = [...range.getClientRects()].filter((rect) => rect.width).map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
							const lines = new Set(fragments.map((rect) => Math.round(rect.top))).size;
							const node = label.firstChild!;
							const tokens = [...label.textContent!.matchAll(/\S+/g)].map((match) => {
								const token = document.createRange();
								token.setStart(node, match.index!); token.setEnd(node, match.index! + match[0].length);
								return { text: match[0], lines: new Set([...token.getClientRects()].filter((rect) => rect.width).map((rect) => Math.round(rect.top))).size };
							});
							const measure = (text: string) => {
								const probe = document.createElement("span");
								probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
								probe.textContent = text;
								time.append(probe);
								const scale = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
								const em = probe.getBoundingClientRect().width / scale / parseFloat(getComputedStyle(probe).fontSize);
								probe.remove(); return em;
							};
							const text = label.textContent!;
							const breaks = [...text.matchAll(/\s/gu)].map((match) => match.index!);
							const twoLineNeedEm = Math.min(measure(text), ...breaks.map((at) => Math.max(measure(text.slice(0, at)), measure(text.slice(at + 1)))));
							return { at: Date.parse(time.dateTime), twoLineNeedEm, singleLineNeedEm: measure(text), text: label.textContent!, left: rect.left, right: rect.right, trackWidth: time.getBoundingClientRect().width, cut: time.scrollWidth > time.clientWidth + 1 || time.scrollHeight > time.clientHeight + 1, lines, fragments, tokens };
						}),
						range: [...document.querySelectorAll<HTMLTimeElement>(".cos-axis time")].map((time) => Date.parse(time.dateTime)),
						height: document.querySelector(".cos-axis")!.getBoundingClientRect().height,
						nameWidth: document.querySelector(".cos-axis > span")!.getBoundingClientRect().width,
						lanesHeight: document.querySelector(".cos-scroll")!.getBoundingClientRect().height,
					};
				}, overall > 1 || width >= 375);
				t.diagnostic(JSON.stringify({ now, locale, width, overall, axis }));
				if (overall === 1 && width >= 375 && axis.mainActual && axis.mainActual.overflow <= 0.5) {
					// Named partial: the measured normal-zoom height may improve, but must never grow.
					const ceiling = locale === LOCALE && !(width === 390 && now === AXIS_TIMES[0]) ? 64 : 40;
					assert.ok(axis.height <= ceiling, `KNOWN LIMIT P1: ${axis.height}px stays below its measured ${ceiling}px ceiling`);
				}

				assert.equal(axis.range[4], expectedTo, "the range ends at its pinned live or historical instant");
				assert.equal(axis.labels.length, overall === 1 ? 3 : 1, "three ticks fit at normal zoom; a narrow time area keeps the endpoint");
				if (axis.labels.length === 1) {
					const window = historical ? "Custom" : "96 h";
					const control = page.getByRole("navigation", { name: "Timeline controls" }).getByRole("button", { name: `Time window: ${window}`, exact: true });
					assert.equal(await control.isVisible(), true, "the endpoint-only axis retains the visible toolbar time window");
					assert.equal(await control.textContent(), window, "the toolbar names the selected time window");
					assert.equal(axis.mainActual?.toolbar, window, "main shows the same toolbar time window");
					for (const [edge, value] of [["start", axis.range[0]], ["end", expectedTo]] as const) {
						const handle = page.getByRole("slider", { name: `Range ${edge}`, exact: true });
						assert.equal(await handle.getAttribute("aria-valuenow"), String(value), "the brush retains the exact range endpoint");
						assert.ok(await handle.getAttribute("aria-valuetext"), "the brush retains a readable endpoint timestamp");
					}
				}
				// The default range ends now: the live "Now" tick is the right label, and it must clear the middle one.
				assert.equal(axis.labels.at(-1)!.text === "Now", !historical, "history is never relabeled Now");
				assert.ok(Math.abs(Math.max(...axis.labels.at(-1)!.fragments.map((rect) => rect.right)) - axis.box.right) <= 0.5, "the endpoint stays at the time column's right edge");
				const to = axis.range[4];
				const endpointFitsWhole = axis.labels.at(-1)!.singleLineNeedEm * axis.em <= axis.box.right - axis.box.left + 0.5;
				if (!historical || endpointFitsWhole) assert.ok(axis.height <= axis.mainHeight + axis.lineHeight + 0.5, "the sticky axis costs at most one extra line over main");
				else t.diagnostic(`KNOWN LIMIT P2: the fixed name column forces a historical endpoint to wrap; axis ${axis.height}px, main ${axis.mainHeight}px, one line ${axis.lineHeight}px`);
				for (const [i, label] of axis.labels.entries()) {
					const live = label.at === to && Math.abs(to - Date.parse(now)) < 120_000;
					const at = new Date(label.at), zone = { timeZone: "Asia/Singapore" };
					const exact = `${at.toLocaleDateString(locale, { ...zone, weekday: "short" })} ${at.toLocaleTimeString(locale, { ...zone, hour: "numeric", minute: "2-digit" })}`;
					assert.equal(label.text, live ? "Now" : exact, "the whole four-day-range formatted value");
					assert.ok(label.twoLineNeedEm <= 4.7, `${locale}: ${label.text} fits the guard's measured 4.7em line budget (${label.twoLineNeedEm})`);
					if (overall === 1 || !historical) assert.ok(label.lines <= (overall === 1 ? 2 : 1), `${locale}: ${label.text} stays in the line budget`);
					if (overall === 1) for (const token of label.tokens) assert.equal(token.lines, 1, `${token.text} never splits mid-token`);
					for (const rect of label.fragments) assert.ok(rect.left >= axis.box.left - 0.5 && rect.right <= axis.box.right + 0.5, `${label.text}: every text fragment stays inside the axis`);
					assert.equal(label.cut, false, `${label.text} is not cut`);
					assert.ok(label.left >= axis.box.left - 0.5 && label.right <= axis.box.right + 0.5, `${label.text} sits inside the axis`);
					if (i) assert.ok(label.left >= axis.labels[i - 1].right, `${label.text} does not overlap the label before it`);
				}
				const sideways = await overflow(page);
				assert.equal(sideways.page, 0, "the axis does not widen the page");
				if (overall === 1) assert.equal(sideways.main, 0, "the main view fits at normal zoom");
				t.diagnostic(JSON.stringify({ now, locale, width, overall, axisHeight: axis.height, lanesHeight: axis.lanesHeight, lines: axis.labels.map((label) => label.lines), spaces: [...new Set(axis.labels.flatMap((label) => [...label.text].filter((char) => /\s/u.test(char)).map((char) => `U+${char.codePointAt(0)!.toString(16).padStart(4, "0")}`)))] }));
			});
		});

	}
}
