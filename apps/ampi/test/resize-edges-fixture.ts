import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { build } from "vite";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import { engineSkip } from "./engines.ts";

// The owner's resize incident (ui-resize-edges): the real App and stylesheet, built in memory from web/src, on the
// synthetic demo hub (scripts/pi-demo.ts). Real mouse down/move/up drive both edges in Chromium and in WebKit, the
// macOS shell's engine. One gesture rule: the grabbed point stays under the cursor within 1 px at every move, at any
// display size, and release commits exactly the drawn width. resize-edges.test.ts and resize-edges-limits.test.ts
// register the cases.

const web = fileURLToPath(new URL("../web", import.meta.url));
const app = fileURLToPath(new URL("..", import.meta.url));
const hubScript = new URL("../scripts/verify/hub.mjs", import.meta.url).href;
const { refusingPath, FORBIDDEN_PORTS } = (await import(hubScript)) as { refusingPath(dir: string, path?: string): string; FORBIDDEN_PORTS: number[] };
type Read = { port: number; host: string; auth: { bearer: string }; timeoutMs?: number };
const { threadsSnapshot, topicSnapshot } = (await import(new URL("../scripts/verify/live-rows.mjs", import.meta.url).href)) as { threadsSnapshot(o: Read): Promise<{ id: string; live?: boolean }[]>; topicSnapshot(o: Read & { topic: object }): Promise<unknown> };
const LEAD = "#/h/devbox/t/pi%3Asess-lead?p=arc";
export const EDGES = { sidebar: { min: 220, max: 420, grow: 1, key: "ampi.sidebar.width", css: "--side-w" }, panel: { min: 320, max: 720, grow: -1, key: "ampi.panel.width", css: "--panel-w" } } as const;
type Side = keyof typeof EDGES;

let hub: { origin: string; key: string; demo: string } | undefined;
let files: Map<string, { body: string | Uint8Array; type: string }> | undefined;
const browsers = new Map<string, Promise<Browser>>();

async function appBundle() {
	const result = await build({ configFile: join(web, "vite.config.ts"), root: web, logLevel: "silent", build: { write: false, outDir: "dist" } });
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { fileName: string; type: string; code?: string; source?: string | Uint8Array }[] };
	const type = (name: string) => (name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
	return new Map(output.output.map((item) => [`/${item.fileName}`, { body: item.code ?? item.source!, type: type(item.fileName) }]));
}

/** Kills the demo hub's process group and deletes its run directory, also when a hook times out before `after`. */
let stopHub = () => {};
process.once("exit", () => stopHub());

async function startHub() {
	const run = mkdtempSync(join(tmpdir(), "ampi-resize-"));
	const home = join(run, "home"), demo = join(run, "demo"), log = join(run, "hub.log");
	mkdirSync(join(home, ".ampi"), { recursive: true });
	const env = { ...process.env, PATH: refusingPath(join(run, "bin"), process.env.PATH), HOME: home, AMPI_HOME: join(home, ".ampi"), AMPI_HUB_CONFIG: join(home, ".ampi/hub.json"), PI_CODING_AGENT_DIR: join(demo, "agent"), DEMO_DIR: demo, DEMO_WEB: "external", PORT: "0" };
	const child = spawn(process.execPath, ["scripts/pi-demo.ts"], { cwd: app, detached: true, env, stdio: ["ignore", openSync(log, "a"), openSync(log, "a")] });
	child.unref();
	stopHub = () => {
		stopHub = () => {};
		try { process.kill(-child.pid!, "SIGKILL"); } catch {}
		rmSync(run, { recursive: true, force: true });
	};
	const deadline = Date.now() + 50_000;
	const wait = async <T>(phase: string, poll: () => Promise<T | undefined>): Promise<T> => {
		while (Date.now() < deadline) {
			const value = await poll().catch(() => undefined);
			if (value !== undefined) return value;
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`demo hub: ${phase} not ready in 50 s. Log tail: ${readFileSync(log, "utf8").slice(-600).replace(/k=[0-9a-f]+/g, "k=<redacted>")}`);
	};
	const [, port, key] = await wait("URL", async () => readFileSync(log, "utf8").match(/demo hub: http:\/\/127\.0\.0\.1:(\d+)\/\?k=([0-9a-f]+)/) ?? undefined);
	assert.ok(Number(port) < FORBIDDEN_PORTS[0]! || Number(port) > FORBIDDEN_PORTS[1]!, "the demo hub never takes an owner port");
	const read = { port: Number(port), host: "devbox", auth: { bearer: key! }, timeoutMs: 3000 };
	// The lead is live once the demo Host reads its fake Herdr; only then does a file append stream to the page.
	await wait("live lead", async () => ((await threadsSnapshot(read)).find((t) => t.id === "pi:sess-lead")?.live ? true : undefined));
	// A cold hub derives the lead's transcript first; a page opened before that shows "Loading…" for long.
	await wait("lead transcript", () => topicSnapshot({ ...read, topic: { kind: "thread", threadId: "pi:sess-lead" }, timeoutMs: 10_000 }));
	return { origin: `http://127.0.0.1:${port}`, key: key!, demo };
}

before(async () => {
	[files, hub] = await Promise.all([appBundle(), startHub()]);
});
after(async () => {
	for (const browser of browsers.values()) await (await browser).close().catch(() => {});
	stopHub();
});

export const ENGINES: [string, BrowserType, () => string | undefined][] = [
	["chromium", chromium, () => findChrome()],
	["webkit", webkit, () => webkit.executablePath()],
];

export async function open(t: TestContext, engine: string, type: BrowserType, path: string | undefined, { display }: { display?: Record<string, number> } = {}): Promise<Page> {
	// A fulfilled document loses its loopback address space; Chromium's Local Network Access check then blocks the hub socket.
	const args = engine === "chromium" ? ["--disable-features=LocalNetworkAccessChecks"] : [];
	if (!browsers.has(engine)) browsers.set(engine, type.launch({ headless: true, args, ...(path ? { executablePath: path } : {}) }));
	const browser = await browsers.get(engine)!;
	const context = await browser.newContext({ viewport: { width: 1600, height: 800 } });
	t.after(() => context.close());
	const page = await context.newPage();
	page.setDefaultTimeout(20_000);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	t.after(() => assert.deepEqual(errors, [], "no page error"));
	// The hub keeps auth and data; the page is this checkout's web/src, built in memory.
	const own = (url: URL) => url.origin === hub!.origin && (url.pathname === "/" || files!.has(url.pathname));
	await page.route(own, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const file = files!.get(path === "/" ? "/index.html" : path)!;
		const response = await route.fetch();
		return route.fulfill({ response, status: 200, body: typeof file.body === "string" ? file.body : Buffer.from(file.body), contentType: file.type });
	});
	await page.addInitScript((display) => {
		if (sessionStorage.getItem("seeded")) return;
		sessionStorage.setItem("seeded", "1");
		localStorage.setItem("ampi.panel", "arc");
		if (display) localStorage.setItem("ampi.display", JSON.stringify(display));
	}, display);
	await page.goto(`${hub!.origin}/?k=${hub!.key}${LEAD}`);
	await page.locator(".panel-edge").waitFor();
	await page.locator(".transcript [data-entry]").first().waitFor({ state: "attached" });
	return page;
}

/** Viewport geometry of one edge: its centre line, the pane's drawn width, the committed values. */
export async function read(page: Page, side: Side) {
	return page.evaluate(([side, css, key]) => {
		const edge = document.querySelector<HTMLElement>(`.${side}-edge`)!;
		const rect = edge.getBoundingClientRect();
		const app = document.querySelector<HTMLElement>(".app")!;
		return {
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
			pane: edge.parentElement!.getBoundingClientRect().width,
			now: Number(edge.getAttribute("aria-valuenow")),
			css: parseFloat(app.style.getPropertyValue(css)),
			saved: Number(localStorage.getItem(key)),
			overlay: app.classList.contains("panel-overlay"),
			scale: app.getBoundingClientRect().width / app.offsetWidth,
		};
	}, [side, EDGES[side].css, EDGES[side].key] as const);
}

export async function eventually(check: () => Promise<boolean>, what: string) {
	for (let i = 0; i < 40; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
	assert.fail(what);
}
export const near = (actual: number, expected: number, what: string, tolerance = 1) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual.toFixed(2)} vs ${expected.toFixed(2)}`);

/** Streams one reply into the lead Session's file; the hub's feeds re-render App and the transcript. */
function stream(text: string) {
	const dir = join(hub!.demo, "agent/sessions");
	const file = readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))).find((f) => f.endsWith("/lead.jsonl"))!;
	const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!).id;
	appendFileSync(file, JSON.stringify({ type: "message", id: `resize-${Date.now()}`, parentId: last, timestamp: new Date().toISOString(), message: { role: "assistant", model: "claude-sonnet-5-5", provider: "anthropic", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, timestamp: Date.now(), content: [{ type: "text", text }] } }) + "\n");
}

/** Registers the edge gesture test for each display setting, per side and engine. */
export function edgeCases(displays: readonly (readonly [string, Record<string, number> | undefined])[]) {
	for (const [engine, type, path] of ENGINES) {
		const skip = engineSkip(engine);
		for (const [label, display] of displays) {
			for (const side of ["sidebar", "panel"] as const) {
				test(`resize ${engine} ${label}: the ${side} edge stays under the cursor, survives a re-render, commits the drawn width`, { skip }, async (t) => {
					const page = await open(t, engine, type, path(), { display });
					const { grow } = EDGES[side];
					const start = await read(page, side);
					// A press without a move changes nothing.
					await page.mouse.move(start.x, start.y);
					await page.mouse.down();
					await page.mouse.up();
					assert.deepEqual(await read(page, side), start, "a click leaves the width alone");
					await page.mouse.down();
					for (const dx of [1, 2, 10]) {
						await page.mouse.move(start.x + grow * dx, start.y);
						near((await read(page, side)).x, start.x + grow * dx, `edge after a ${dx} px move`);
					}
					// A streamed reply re-renders App mid-gesture; the gesture keeps its basis.
					const text = `Resize stream ${engine} ${side} ${Date.now()}`;
					stream(text);
					// A reader at the end paints the reply; a reader away from it gets the "↓ N new" button. Either is a re-render.
					await page.locator(".transcript").getByText(text).or(page.getByTitle("Go to the newest entry and follow")).first().waitFor({ state: "attached" });
					await page.mouse.move(start.x + grow * 120, start.y + 200);
					const moved = await read(page, side);
					near(moved.x, start.x + grow * 120, "edge after a 120 px move off the handle");
					near(moved.pane - start.pane, 120, "the pane grows by the move");
					await page.mouse.up();
					const released = await read(page, side);
					near(released.x, moved.x, "release does not move the edge");
					assert.equal(released.now, released.css, `aria-valuenow is the drawn width: ${JSON.stringify(released)}`);
					await eventually(async () => (await read(page, side)).saved === released.css, `the saved width is the drawn width: ${JSON.stringify(released)}`);
					near(released.css * released.scale, released.pane, "the CSS width draws the pane", 1);
					await page.reload();
					await page.locator(`.${side}-edge`).waitFor();
					const reloaded = await read(page, side);
					assert.equal(reloaded.now, released.now, "a reload keeps the width");
					near(reloaded.x, released.x, "a reload keeps the edge");
				});
			}
		}
	}
}
