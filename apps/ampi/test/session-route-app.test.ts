import "./bound.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { build } from "vite";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import { engineSkip } from "./engines.ts";

// One Session has one route, `#/h/<Host ID>/t/<thread>`; the thread ID picks the Host's source. The real App, built in
// memory from web/src, runs against a hub that is a script on the page's WebSocket. One Host ID serves a Pi source and a
// durable source, and the hub lists its Hosts only after the App's first render, like a hub that answers late. A Session
// view mounts only under a listed source, so no frame in any case names the bare Host ID.

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://localhost";
const PI = { id: "devbox", link: "devbox#pi", label: "devbox", kind: "pi-local", status: "connected" };
const DURABLE = { id: "devbox", link: "devbox#durable", label: "devbox", kind: "durable", status: "connected" };
const THREAD = "c1";
const ROUTE = `#/h/devbox/t/${THREAD}`;
const view = { conversationId: THREAD, hiddenBefore: false, entries: [{ id: "e0", kind: "user", text: "Hello", images: 0 }], live: {}, inbox: {}, agent: { cwd: "/work" }, usage: { costUsd: 0 } };
const thread = { id: THREAD, title: "One route", createdAt: 0, updatedAt: 0, kind: "thread", activity: "idle", queued: 0, costUsd: 0 };
const SHELL_KEY = `ampi.shell.${DURABLE.link}|${THREAD}`;
const SHELL = { [SHELL_KEY]: "T1", "ampi.panel": "shell" };

async function appFiles() {
	const result = await build({ configFile: join(web, "vite.config.ts"), root: web, logLevel: "silent", build: { write: false, outDir: "dist" } });
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { fileName: string; type: string; code?: string; source?: string | Uint8Array }[] };
	const type = (name: string) => (name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
	return new Map(output.output.map((item) => [`/${item.fileName}`, { body: item.code ?? item.source!, type: type(item.fileName) }]));
}

let files: ReturnType<typeof appFiles> | undefined;
const browsers: Partial<Record<string, Promise<Browser>>> = {};
after(async () => { for (const b of Object.values(browsers)) await (await b)?.close(); });

type Host = typeof PI & Record<string, unknown>;
type Frame = { t: string; host?: string; op?: string; topic?: { kind?: string } };
type Hub = { page: Page; frames: Frame[]; list(hosts: Host[]): void };
/** `hosts`: the first Host list, 300 ms after the socket opens, or none. `refuse`: the hub closes every socket. */
async function open(t: TestContext, engine: "chromium" | "webkit", opts: { storage?: Record<string, string>; hosts?: Host[] | null; refuse?: true } = {}): Promise<Hub> {
	const served = await (files ??= appFiles());
	const browser = await (browsers[engine] ??= engine === "webkit" ? webkit.launch({ headless: true }) : chromium.launch({ headless: true, executablePath: findChrome() }));
	const context = await browser.newContext({ viewport: { width: 1400, height: 800 } });
	t.after(() => context.close());
	await context.addInitScript((storage) => { if (!sessionStorage.getItem("seeded")) { for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, opts.storage ?? {});
	const page = await context.newPage();
	page.setDefaultTimeout(10_000);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const frames: Frame[] = [];
	t.after(() => {
		assert.deepEqual(errors, [], "no page error");
		assert.deepEqual(frames.filter((f) => f.host === PI.id), [], "no frame names the bare Host ID");
	});
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		const file = url.origin === ORIGIN ? served.get(url.pathname === "/" ? "/index.html" : url.pathname) : undefined;
		return file ? route.fulfill({ status: 200, body: typeof file.body === "string" ? file.body : Buffer.from(file.body), contentType: file.type }) : route.abort();
	});
	const sends: ((frame: unknown) => void)[] = [];
	await page.routeWebSocket("**/ws", (client) => {
		if (opts.refuse) return client.close();
		const send = (frame: unknown) => client.send(JSON.stringify(frame));
		sends.push(send);
		const hosts = opts.hosts === undefined ? [PI, DURABLE] : opts.hosts;
		if (hosts) setTimeout(() => send({ t: "hosts", hosts }), 300);
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			frames.push(frame);
			const durable = frame.host !== PI.link;
			if (frame.t === "sub") send({ t: "snap", sid: frame.sid, value: frame.topic?.kind === "thread" ? view : frame.topic?.kind === "threads" ? { threads: durable ? { [THREAD]: thread } : {} } : frame.topic?.kind === "terms" ? { terms: { T1: { id: "T1", title: "shell · One route", cwd: "/work" } } } : frame.topic?.kind === "term" ? { chunks: [] } : {} });
			else if (frame.t === "req" && frame.op === "term.open") send({ t: "res", id: frame.id, ok: true, value: { id: "T2" } });
			else if (frame.t === "req" || frame.t === "hub") send({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
		});
	});
	return { page, frames, list: (hosts) => { for (const send of sends) send({ t: "hosts", hosts }); } };
}

const composer = (page: Page) => page.getByRole("textbox", { name: "Message the agent" });
const unresolved = (page: Page) => page.locator("[data-session-unresolved]");

for (const engine of ["chromium", "webkit"] as const) {
	test(`session route app (${engine}): a reload on the one route keeps the shell the Session's link key saved`, { skip: engineSkip(engine) }, async (t) => {
		const { page, frames } = await open(t, engine, { storage: SHELL });
		await page.goto(`${ORIGIN}/${ROUTE}`);
		await page.locator(".term-box[data-term]").waitFor();
		await page.waitForTimeout(600);
		assert.equal(await page.locator(".term-box[data-term]").getAttribute("data-term"), "T1");
		assert.deepEqual(frames.filter((f) => f.op === "term.open"), [], "the reload opened no second shell");
		const shells = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("ampi.shell.")).map((k) => [k, localStorage.getItem(k)])));
		assert.deepEqual(shells, { [SHELL_KEY]: "T1" });
	});

	test(`session route app (${engine}): a durable thread under the bare Host ID opens the durable source, and an older link-key cite arrives as the one route`, { skip: engineSkip(engine) }, async (t) => {
		const { page, frames } = await open(t, engine);
		await page.goto(`${ORIGIN}/#/v/overview`);
		await page.waitForTimeout(500);
		const start = await page.evaluate(() => history.length);
		// A cite an older build stored in Arc or Rarebit text, by the durable link key.
		await page.evaluate((thread) => {
			const a = document.createElement("a");
			a.href = `#/h/devbox%23durable/t/${thread}?e=e0`;
			a.textContent = "[#e0]";
			a.id = "old-cite";
			document.body.append(a);
		}, THREAD);
		await page.locator("#old-cite").click();
		await composer(page).waitFor();
		assert.deepEqual(await page.evaluate(() => ({ hash: location.hash, entries: history.length })), { hash: `${ROUTE}?e=e0`, entries: start + 1 });
		const threadSubs = frames.filter((f) => f.t === "sub" && f.topic?.kind === "thread").map((f) => f.host);
		assert.ok(threadSubs.length > 0 && threadSubs.every((host) => host === DURABLE.link), `the thread subscribed to the durable source only: ${threadSubs}`);
		await page.evaluate(() => history.back());
		await page.waitForFunction(() => location.hash === "#/v/overview");
		assert.equal(await page.evaluate(() => history.length), start + 1, "Back left the Session in one step");
	});

	test(`session route app (${engine}): when the hub drops the Session's source, its views unmount and say why`, { skip: engineSkip(engine) }, async (t) => {
		const { page, frames, list } = await open(t, engine, { storage: SHELL });
		await page.goto(`${ORIGIN}/${ROUTE}`);
		await composer(page).waitFor();
		await page.locator(".term-box[data-term]").waitFor();
		list([PI]);
		await unresolved(page).filter({ hasText: "This Session's agent type is not on Host devbox." }).waitFor();
		assert.equal(await composer(page).count(), 0, "the Session's view unmounted");
		assert.equal(await page.locator(".term-box[data-term]").count(), 0, "the shell unmounted");
		assert.deepEqual(frames.filter((f) => f.op === "term.open"), [], "no shell opened");
	});

	test(`session route app (${engine}): a link blip keeps the Session's view mounted and its draft`, { skip: engineSkip(engine) }, async (t) => {
		const { page, list } = await open(t, engine);
		await page.goto(`${ORIGIN}/${ROUTE}`);
		await composer(page).fill("half a thought");
		const mounted = await composer(page).elementHandle();
		// The hosts frame lists every link in every status, so resolution holds through the blip.
		list([PI, { ...DURABLE, status: "disconnected", since: 0, error: "connection reset", hint: "retrying" }]);
		await page.waitForTimeout(300);
		list([PI, { ...DURABLE, status: "connecting", phase: "transport", since: 0, hint: "connecting" }]);
		await page.waitForTimeout(300);
		list([PI, DURABLE]);
		await page.waitForTimeout(300);
		assert.equal(await unresolved(page).count(), 0, "the route stayed resolved");
		assert.equal(await mounted!.evaluate((el) => el.isConnected), true, "the composer was not unmounted and remounted");
		assert.equal(await composer(page).inputValue(), "half a thought", "the draft is kept");
	});

	test(`session route app (${engine}): a Pi thread on a Host that lists only its durable source waits for the Pi source`, { skip: engineSkip(engine) }, async (t) => {
		const { page, frames, list } = await open(t, engine, { hosts: [DURABLE] });
		await page.goto(`${ORIGIN}/#/h/devbox/t/pi%3Asess-a`);
		await unresolved(page).filter({ hasText: "This Session's agent type is not on Host devbox." }).waitFor();
		assert.equal(await composer(page).count(), 0, "no Session view under the durable source");
		assert.deepEqual(frames.filter((f) => f.t === "sub" && f.topic?.kind === "thread"), [], "no thread subscribed");
		list([DURABLE, PI]);
		await composer(page).waitFor();
		const threadSubs = frames.filter((f) => f.t === "sub" && f.topic?.kind === "thread").map((f) => f.host);
		assert.deepEqual(threadSubs, [PI.link], "the thread subscribed once, to the Pi source");
	});

	test(`session route app (${engine}): a hub that never lists its Hosts shows a quiet view, then a wait, then a cause and a reload`, { skip: engineSkip(engine) }, async (t) => {
		const { page } = await open(t, engine, { hosts: null });
		// An installed clock runs at real speed until it is paused. Paused before the page loads, the view's 300 ms and 5 s
		// marks pass only through runFor, so a slow machine cannot reach them early.
		await page.clock.install({ time: 0 });
		await page.clock.pauseAt(1000);
		await page.goto(`${ORIGIN}/${ROUTE}`);
		await unresolved(page).waitFor({ state: "attached" });
		assert.equal(await unresolved(page).textContent(), "", "a fast boot shows no message");
		await page.clock.runFor(400);
		await unresolved(page).filter({ hasText: "Connecting to the hub…" }).waitFor();
		await page.clock.runFor(5000);
		await unresolved(page).filter({ hasText: "The hub has not listed its Hosts." }).waitFor();
		await unresolved(page).getByRole("button", { name: "Reload" }).waitFor();
	});

	test(`session route app (${engine}): with no hub connection, a Session route says so with the Sidebar's words`, { skip: engineSkip(engine) }, async (t) => {
		const { page } = await open(t, engine, { refuse: true });
		await page.goto(`${ORIGIN}/${ROUTE}`);
		const note = unresolved(page).filter({ hasText: "Not connected to the hub." });
		await note.waitFor();
		assert.equal(await note.textContent(), await page.locator("[data-hub-disconnected]").textContent());
	});

	test(`session route app (${engine}): a route with a malformed escape renders the Overview`, { skip: engineSkip(engine) }, async (t) => {
		const { page } = await open(t, engine);
		await page.goto(`${ORIGIN}/#/h/devbox/t/%E0%A4`);
		await page.locator(".main-slot .topbar b", { hasText: "Overview" }).waitFor();
		assert.equal(await page.evaluate(() => location.hash), "#/h/devbox/t/%E0%A4", "the address stays as typed");
	});
}
