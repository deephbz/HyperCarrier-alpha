// AmPi perf browser driver: the runner's scenario hook. It launches its own headless Chrome, drives the page over raw
// CDP (the `ws` package AmPi already depends on), and writes <runDir>/trace-browser.json in Chrome Trace Event Format
// on the runner's Unix-epoch µs clock.
//
//   runScenario(ctx) → { ok, marks: [{ name, ts, dur?, args? }], error?, stats? }   (ts and dur in µs)
//   Points: navigate, first-paint, first-data, sessions-listed, scenario-end. One switch-done-first or
//   switch-done-revisit per switch, with dur from the click to the painted transcript and args.visit.
//   ctx = { url, origin, runDir, scenario: "startup"|"switch"|"idle", sessions, epochUs(), signal, log(msg) }
//
// `ctx.url` carries the hub's access key. It never reaches a file or a log: every string in the trace is scrubbed.
// Scenarios: startup = cold load until first-data and the Session list; idle = startup + 1 s; switch = startup, K
// first-visit Session switches, the same K again, then 1 s idle.
// Chrome: AMPI_PERF_CHROME, else Playwright's newest cached headless shell, else Google Chrome.
// Trace categories: AMPI_PERF_CATEGORIES (comma list) replaces the default set.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CATEGORIES = [
	"-*",
	"devtools.timeline",
	"disabled-by-default-devtools.timeline",
	"disabled-by-default-devtools.timeline.frame",
	"v8",
	"v8.execute",
	"blink.user_timing",
	"loading",
	"navigation",
	"toplevel",
	"__metadata",
];
/** The driver's own spans (scenario steps, long tasks) go on this thread of the browser process. */
const DRIVER_TID = 1;
const IDLE_MS = 1000;
const STEP_MS = 15_000;

/** Chrome to launch: an explicit binary, Playwright's newest headless shell, or the installed Google Chrome. */
export function findChrome(env = process.env) {
	if (env.AMPI_PERF_CHROME) return env.AMPI_PERF_CHROME;
	const cache = join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
	const shells = (() => { try { return readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")); } catch { return []; } })()
		.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
	for (const dir of shells) {
		for (const sub of readdirSync(join(cache, dir))) {
			const bin = join(cache, dir, sub, "chrome-headless-shell");
			if (existsSync(bin)) return bin;
		}
	}
	for (const bin of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]) if (existsSync(bin)) return bin;
	return undefined;
}

/**
 * Every secret and every key-shaped link value replaced in serialized JSON. One pass over the text covers every
 * string of a large trace; a hex key needs no JSON escaping. Pure, for tests.
 */
export function scrubText(text, secrets = []) {
	let s = text;
	for (const secret of secrets) if (secret && secret.length >= 8) s = s.split(secret).join("…");
	return s.replace(/([?&]k=)[0-9a-f]{16,}/gi, "$1…");
}

/**
 * Chrome's events moved onto the epoch clock, in whole µs. Processes are named for the merged view: the browser process is
 * `browser`, the others `browser:<Chrome's name>`. Pure, for tests.
 */
export function prepareTrace(events, { offsetUs, browserPid, meta = {} }) {
	const out = [];
	const named = new Set();
	for (const event of events) {
		if (event.ph === "M" && event.name === "process_name") {
			named.add(event.pid);
			const name = event.pid === browserPid ? "browser" : `browser:${event.args?.name ?? "process"}`;
			out.push({ ...event, args: event.pid === browserPid ? { name, clockOffsetUs: offsetUs, ...meta } : { name } });
			continue;
		}
		const next = { ...event };
		// Whole µs: Perfetto reads a fractional epoch µs through a double and misplaces nested slices.
		if (event.ph !== "M" && typeof event.ts === "number") {
			next.ts = Math.round(event.ts + offsetUs);
			if (typeof event.dur === "number") next.dur = Math.round(event.ts + offsetUs + event.dur) - next.ts;
		}
		out.push(next);
	}
	if (!named.has(browserPid)) out.push({ ph: "M", name: "process_name", pid: browserPid, tid: 0, ts: 0, args: { name: "browser", clockOffsetUs: offsetUs, ...meta } });
	out.push({ ph: "M", name: "thread_name", pid: browserPid, tid: DRIVER_TID, ts: 0, args: { name: "perf-driver" } });
	return out;
}

/** The epoch-µs offset to add to Chrome's trace clock, from one mark seen on both clocks. */
export function clockOffset({ markTraceTs, markPageEpochUs, pageSkewUs }) {
	return markPageEpochUs + pageSkewUs - markTraceTs;
}

class Cdp {
	#id = 0;
	#pending = new Map();
	#listeners = new Set();
	constructor(ws) {
		this.ws = ws;
		ws.on("message", (data) => {
			const msg = JSON.parse(String(data));
			if (msg.id !== undefined) {
				const p = this.#pending.get(msg.id);
				if (!p) return;
				this.#pending.delete(msg.id);
				msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
			} else for (const listener of this.#listeners) listener(msg);
		});
		ws.on("close", () => {
			for (const p of this.#pending.values()) p.reject(new Error(`${p.method}: browser connection closed`));
			this.#pending.clear();
		});
	}
	static open(url) {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 << 20 });
			ws.once("open", () => resolve(new Cdp(ws)));
			ws.once("error", reject);
		});
	}
	send(method, params = {}, sessionId) {
		const id = ++this.#id;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject, method });
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}
	/** Resolves with the first event that matches. */
	once(pred, ms, what) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.#listeners.delete(listener); reject(new Error(`timed out waiting for ${what}`)); }, ms);
			const listener = (msg) => { if (pred(msg)) { clearTimeout(timer); this.#listeners.delete(listener); resolve(msg); } };
			this.#listeners.add(listener);
		});
	}
	close() { this.ws.close(); }
}

/** Starts Chrome with a throwaway profile and returns its CDP endpoint. */
async function launch(bin, signal) {
	const profile = mkdtempSync(join(tmpdir(), "ampi-perf-chrome-"));
	const child = spawn(bin, [
		"--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync",
		"--mute-audio", "--window-size=1440,900", "about:blank",
	], { stdio: ["ignore", "ignore", "pipe"] });
	const endpoint = await new Promise((resolve, reject) => {
		let err = "";
		const timer = setTimeout(() => reject(new Error(`Chrome gave no DevTools endpoint: ${err.slice(-300)}`)), 15_000);
		const abort = () => reject(new Error("aborted"));
		signal?.addEventListener("abort", abort, { once: true });
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (d) => {
			err += d;
			const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
			if (m) { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(m[1]); }
		});
		child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${err.slice(-300)}`)); });
	});
	child.stderr.resume();
	return { child, profile, endpoint };
}

/** The runner's scenario hook. */
export async function runScenario(ctx) {
	const { url, runDir, signal, log = () => {} } = ctx;
	const scenario = ctx.scenario ?? "startup";
	const k = Math.max(1, ctx.sessions ?? 10);
	const epochUs = ctx.epochUs ?? (() => (performance.timeOrigin + performance.now()) * 1000);
	const secrets = [new URL(url).searchParams.get("k") ?? ""];
	const marks = [];
	const point = (name, ts) => marks.push({ name, ts });
	const stats = { scenario, sessionsWanted: k };
	const driver = []; // spans on the epoch clock, written with the trace
	const bin = findChrome();
	if (!bin) return { ok: false, marks, error: "no Chrome found: set AMPI_PERF_CHROME" };
	const t0 = epochUs();
	let chrome, cdp, error, traceEvents = [];
	try {
		chrome = await launch(bin, signal);
		cdp = await Cdp.open(chrome.endpoint);
		driver.push({ name: "chrome-launch", ts: t0, dur: epochUs() - t0 });
		stats.launchMs = Math.round((epochUs() - t0) / 1000);
		const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		const page = (method, params) => cdp.send(method, params, sessionId);
		const evaluate = async (expression) => {
			const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`.slice(0, 300));
			return r.result.value;
		};
		await page("Page.enable");
		await page("Runtime.enable");
		// Before any page script: turn the web marks on and keep long tasks.
		await page("Page.addScriptToEvaluateOnNewDocument", {
			source: "window.__AMPI_PERF__=true;window.__AMPI_LONG__=[];try{new PerformanceObserver((l)=>{for(const e of l.getEntries())window.__AMPI_LONG__.push([e.startTime,e.duration])}).observe({type:'longtask',buffered:true})}catch{}",
		});
		const categories = process.env.AMPI_PERF_CATEGORIES?.split(",") ?? CATEGORIES;
		await cdp.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: categories.filter((c) => !c.startsWith("-")), excludedCategories: categories.filter((c) => c.startsWith("-")).map((c) => c.slice(1)) } });

		const abortable = (promise) => new Promise((resolve, reject) => {
			if (signal?.aborted) return reject(new Error("aborted by the runner"));
			const abort = () => reject(new Error("aborted by the runner"));
			signal?.addEventListener("abort", abort, { once: true });
			promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
		});
		/** Waits in the page for the mark `ampi:<name>` (counting earlier ones), returns its epoch µs. */
		const waitMark = (name, after = 0) => abortable(evaluate(`new Promise((resolve, reject) => {
			const find = () => performance.getEntriesByName("ampi:${name}", "mark")[${after}];
			const hit = find(); if (hit) return resolve(performance.timeOrigin + hit.startTime);
			const obs = new PerformanceObserver(() => { const m = find(); if (m) { obs.disconnect(); clearTimeout(t); resolve(performance.timeOrigin + m.startTime); } });
			obs.observe({ type: "mark" });
			const t = setTimeout(() => { obs.disconnect(); reject(new Error("no ampi:${name} within ${STEP_MS} ms")); }, ${STEP_MS});
		})`));

		// Page epoch → runner epoch: the best of five round trips, then one mark that also lands in Chrome's trace.
		let pageSkewUs = 0, rtt = Infinity;
		const sync = async () => {
			for (let i = 0; i < 10; i++) {
				const a = epochUs();
				const pageUs = await evaluate("(performance.timeOrigin + performance.now()) * 1000");
				const b = epochUs();
				if (b - a < rtt) { rtt = b - a; pageSkewUs = (a + b) / 2 - pageUs; }
			}
		};
		const toRunner = (pageMs) => Math.round(pageMs * 1000 + pageSkewUs);
		const step = async (name, fn) => {
			const ts = epochUs();
			try { return await fn(); } finally { driver.push({ name, ts, dur: epochUs() - ts }); }
		};

		const navStart = epochUs();
		stats.setupMs = Math.round((navStart - t0) / 1000) - stats.launchMs;
		point("navigate", navStart);
		await step("cold-load", async () => {
			const loaded = cdp.once((m) => m.method === "Page.loadEventFired" && m.sessionId === sessionId, STEP_MS, "page load");
			await page("Page.navigate", { url });
			await abortable(loaded);
		});
		await sync();
		const syncPageUs = await evaluate("(() => { const at = (performance.timeOrigin + performance.now()) * 1000; performance.mark('ampi:clock-sync'); return at; })()");
		stats.clockRttUs = Math.round(rtt);
		await step("first-data", async () => {
			for (const name of ["first-paint", "first-data", "sessions-listed"]) {
				try { point(name, toRunner(await waitMark(name))); } catch (e) { if (name !== "sessions-listed") throw e; stats.sessionsListed = false; }
			}
		});

		if (scenario === "switch") {
			// The Pi sidebar collapses Sessions without a Herdr pane. Open every group before the timed switches.
			stats.groupsOpened = await evaluate(`(() => { const closed = [...document.querySelectorAll(".sidebar-slot .group-row[aria-expanded=false]")]; for (const b of closed) b.click(); return closed.length; })()`);
			if (stats.groupsOpened) await evaluate("new Promise((ok) => requestAnimationFrame(() => setTimeout(ok, 0)))");
			const threads = await evaluate(`[...document.querySelectorAll(".sidebar-slot .row[data-thread]")].map((r) => r.dataset.thread).slice(0, ${k})`);
			stats.sessionsVisited = threads.length;
			if (!threads.length) {
				const seen = await evaluate(`JSON.stringify({ path: location.pathname, slot: !!document.querySelector(".sidebar-slot"), sections: document.querySelectorAll(".side-section").length, rows: document.querySelectorAll(".row[data-thread]").length, heads: [...document.querySelectorAll(".side-head .grow")].map((e) => e.textContent) })`);
				throw new Error(`the sidebar lists no Sessions to switch to: ${seen}`);
			}
			const switches = { first: [], revisit: [] };
			for (const [round, list] of [["first", threads], ["revisit", threads]]) {
				for (const id of list) {
					const done = await evaluate(`performance.getEntriesByName("ampi:switch-done", "mark").length`);
					// The click time is taken in the page, so the switch excludes the CDP round trip.
					const clickAt = toRunner(await evaluate(`(() => { const row = [...document.querySelectorAll(".sidebar-slot .row[data-thread]")].find((r) => r.dataset.thread === ${JSON.stringify(id)}); if (!row) throw new Error("row gone"); performance.mark("ampi:switch-click"); const at = performance.timeOrigin + performance.now(); row.click(); return at; })()`));
					const end = toRunner(await waitMark("switch-done", done));
					const visit = switches[round].length;
					driver.push({ name: `switch-${round}`, ts: clickAt, dur: end - clickAt, args: { visit } });
					switches[round].push(end - clickAt);
					marks.push({ name: round === "first" ? "switch-done-first" : "switch-done-revisit", ts: end, dur: end - clickAt, args: { visit } });
				}
			}
			const ms = (list) => list.map((us) => Math.round(us / 100) / 10);
			stats.switchMs = { first: ms(switches.first), revisit: ms(switches.revisit) };
		}
		if (scenario === "switch" || scenario === "idle") await step("idle", () => abortable(new Promise((r) => setTimeout(r, IDLE_MS))));
		point("scenario-end", epochUs());

		const page_ = await evaluate(`(() => { const n = performance.getEntriesByType("navigation")[0]; return { origin: performance.timeOrigin, nav: n && { responseEnd: n.responseEnd, domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd, redirect: n.redirectEnd - n.redirectStart, transfer: n.transferSize }, long: window.__AMPI_LONG__ ?? [] }; })()`);
		stats.navigation = page_.nav;
		stats.longTasks = { count: page_.long.length, totalMs: Math.round(page_.long.reduce((s, [, d]) => s + d, 0)) };
		for (const [start, dur] of page_.long) driver.push({ name: "longtask", ts: toRunner(page_.origin + start), dur: dur * 1000 });

		// Stop tracing and read the stream.
		const collectStart = epochUs();
		const complete = cdp.once((m) => m.method === "Tracing.tracingComplete", 60_000, "trace");
		await cdp.send("Tracing.end");
		const { stream } = (await complete).params;
		let text = "";
		for (;;) {
			const chunk = await cdp.send("IO.read", { handle: stream, size: 8 << 20 });
			text += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data;
			if (chunk.eof) break;
		}
		await cdp.send("IO.close", { handle: stream });
		stats.collectMs = Math.round((epochUs() - collectStart) / 1000);
		stats.traceBytes = text.length;
		const parsed = JSON.parse(text);
		traceEvents = Array.isArray(parsed) ? parsed : parsed.traceEvents;
		const syncEvent = traceEvents.find((e) => e.name === "ampi:clock-sync" && typeof e.ts === "number");
		if (!syncEvent) throw new Error("the clock-sync mark is not in Chrome's trace (is blink.user_timing on?)");
		const offsetUs = clockOffset({ markTraceTs: syncEvent.ts, markPageEpochUs: syncPageUs, pageSkewUs });
		stats.clockOffsetUs = Math.round(offsetUs);
		stats.pageSkewUs = Math.round(pageSkewUs);
		const writeStart = epochUs();
		writeTrace(runDir, traceEvents, driver, { offsetUs, pageSkewUs, clockRttUs: rtt, browserPid: chrome.child.pid, secrets });
		stats.writeMs = Math.round((epochUs() - writeStart) / 1000);
		await page("Page.close").catch(() => {});
	} catch (e) {
		error = String(e?.message ?? e);
		// Keep what the driver measured even when Chrome's trace is lost.
		if (chrome) writeTrace(runDir, [], driver, { offsetUs: 0, pageSkewUs: 0, browserPid: chrome.child.pid, secrets, error });
	} finally {
		const closeStart = epochUs();
		if (cdp) {
			await cdp.send("Browser.close").catch(() => {});
			cdp.close();
		}
		if (chrome) {
			if (chrome.child.exitCode === null && chrome.child.signalCode === null) {
				const exited = new Promise((r) => chrome.child.once("exit", r));
				// Chrome often outlives Browser.close by seconds. The trace is already written, so a short wait suffices.
				const timer = setTimeout(() => chrome.child.kill("SIGKILL"), 500);
				await exited;
				clearTimeout(timer);
			}
			rmSync(chrome.profile, { recursive: true, force: true });
		}
		stats.closeMs = Math.round((epochUs() - closeStart) / 1000);
	}
	log(`browser ${scenario}: ${error ? `failed: ${error}` : "ok"} in ${Math.round((epochUs() - t0) / 1000)} ms (launch ${stats.launchMs} · setup ${stats.setupMs} · collect ${stats.collectMs} · write ${stats.writeMs} · close ${stats.closeMs} ms, trace ${Math.round((stats.traceBytes ?? 0) / 1e6)} MB)`);
	const whole = marks.map((m) => ({ ...m, ts: Math.round(m.ts), ...(m.dur !== undefined ? { dur: Math.round(m.ts + m.dur) - Math.round(m.ts) } : {}) }));
	return { ok: !error, marks: whole, ...(error ? { error } : {}), stats };
}

function writeTrace(runDir, chromeEvents, driver, { offsetUs, pageSkewUs, clockRttUs = 0, browserPid, secrets, error }) {
	const own = driver.map(({ name, cat = "render", ts, dur, args }) => ({ ph: "X", name, cat, pid: browserPid, tid: DRIVER_TID, ts, dur, ...(args ? { args } : {}) }));
	const meta = { pageSkewUs: Math.round(pageSkewUs), clockRttUs: Math.round(clockRttUs), ...(error ? { error: error.slice(0, 200) } : {}) };
	const events = prepareTrace(chromeEvents, { offsetUs, browserPid, meta });
	for (const event of prepareTrace(own, { offsetUs: 0, browserPid })) if (event.ph !== "M") events.push(event);
	writeFileSync(join(runDir, "trace-browser.json"), scrubText(JSON.stringify({ traceEvents: events }), secrets));
}
