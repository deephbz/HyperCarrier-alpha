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

// One Session has one route, `#/h/<Host ID>/t/<thread>`. The real App, built in memory from web/src, runs against a hub
// that is a script on the page's WebSocket. The hub lists its Hosts only after the App's first render, like a hub that
// answers late. A Session view mounts only under a listed Pi Host, so no frame in any case names the bare Host ID. A
// durable thread (an old link or pin) has no source on main: it stays unresolved and names the durable release.

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://localhost";
const PI = { id: "devbox", link: "devbox#pi", label: "devbox", kind: "pi-local", status: "connected" };
const THREAD = "pi:sess-a";
const ROUTE = `#/h/devbox/t/${encodeURIComponent(THREAD)}`;
const DURABLE_THREAD = "c1";
const view = { conversationId: THREAD, hiddenBefore: false, entries: [{ id: "e0", kind: "user", text: "Hello", images: 0 }], live: {}, inbox: {}, agent: { cwd: "/work" }, usage: { costUsd: 0 } };
const thread = { id: THREAD, title: "One route", createdAt: 0, updatedAt: 0, kind: "thread", activity: "idle", queued: 0, costUsd: 0 };

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
type HostsExtra = { skipped?: { id: string; label: string; kind: string }[]; pins?: { host: string; threadId: string; title: string }[] };
/**
 * `hosts`: the first Host list, 300 ms after the socket opens, or none. `extra`: the hosts frame's skipped rows and the
 * hub's pins. `refuse`: the hub closes every socket.
 */
async function open(t: TestContext, engine: "chromium" | "webkit", opts: { storage?: Record<string, string>; hosts?: Host[] | null; extra?: HostsExtra; refuse?: true } = {}): Promise<Hub> {
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
		const hosts = opts.hosts === undefined ? [PI] : opts.hosts;
		if (hosts) setTimeout(() => {
			send({ t: "hosts", hosts, ...(opts.extra?.skipped ? { skipped: opts.extra.skipped } : {}) });
			if (opts.extra?.pins) send({ t: "pins", pins: opts.extra.pins });
		}, 300);
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			frames.push(frame);
			if (frame.t === "sub") send({ t: "snap", sid: frame.sid, value: frame.topic?.kind === "thread" ? view : frame.topic?.kind === "threads" ? { backend: "pi", threads: { [THREAD]: thread } } : {} });
			else if (frame.t === "req" || frame.t === "hub") send({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
		});
	});
	return { page, frames, list: (hosts) => { for (const send of sends) send({ t: "hosts", hosts }); } };
}

const composer = (page: Page) => page.getByRole("textbox", { name: "Message the agent" });
const unresolved = (page: Page) => page.locator("[data-session-unresolved]");

for (const engine of ["chromium", "webkit"] as const) {
	test(`session route app (${engine}): a durable thread route and a durable link-key cite stay unresolved, name the durable release, and subscribe nothing`, { skip: engineSkip(engine) }, async (t) => {
		const { page, frames } = await open(t, engine);
		await page.goto(`${ORIGIN}/#/v/overview`);
		await page.waitForTimeout(500);
		// A cite stored in Arc or Rarebit text by the durable link key.
		await page.evaluate((thread) => {
			const a = document.createElement("a");
			a.href = `#/h/devbox%23durable/t/${thread}?e=e0`;
			a.textContent = "[#e0]";
			a.id = "old-cite";
			document.body.append(a);
		}, DURABLE_THREAD);
		await page.locator("#old-cite").click();
		await unresolved(page).filter({ hasText: "This thread belongs to the durable node." }).waitFor();
		assert.match(await unresolved(page).textContent() ?? "", /release\/durable/);
		assert.equal(await page.evaluate(() => location.hash), `#/h/devbox%23durable/t/${DURABLE_THREAD}?e=e0`, "the cite stays as typed");
		assert.equal(await composer(page).count(), 0, "no Session view mounts");
		assert.deepEqual(frames.filter((f) => f.t === "sub" && f.topic?.kind === "thread"), [], "no thread subscribed");
	});

	test(`session route app (${engine}): skipped hub.json rows show one hint, and a durable pin renders unresolved`, { skip: engineSkip(engine) }, async (t) => {
		const skipped = [{ id: "mac", label: "mac", kind: "local" }, { id: "far", label: "far", kind: "ssh" }];
		const { page, frames } = await open(t, engine, { extra: { skipped, pins: [{ host: "mac#durable", threadId: DURABLE_THREAD, title: "Old durable work" }] } });
		await page.goto(`${ORIGIN}/#/v/overview`);
		await page.locator(`.side-section[data-host="${PI.id}"]`).waitFor();
		const hint = page.locator("[data-skipped-hosts]");
		await hint.waitFor();
		assert.equal(await page.getByText("release/durable", { exact: false }).count(), 1, "the window names the durable release once");
		assert.equal(await hint.getAttribute("data-skipped-hosts"), "mac far");
		assert.match(await hint.textContent() ?? "", /Not shown: mac, far\./);
		const pin = page.locator(`.pin-row[data-pin="${DURABLE_THREAD}"]`);
		await pin.and(page.locator(".gone")).waitFor();
		assert.equal(await pin.locator("a[href]").count(), 0, "the durable pin opens nothing");
		assert.ok(frames.every((f) => f.host === undefined || f.host === PI.link), `every frame names the Pi Host: ${JSON.stringify(frames.map((f) => f.host))}`);
	});

	test(`session route app (${engine}): when the hub drops the Session's Host, its views unmount and say why`, { skip: engineSkip(engine) }, async (t) => {
		const { page, list } = await open(t, engine);
		await page.goto(`${ORIGIN}/${ROUTE}`);
		await composer(page).waitFor();
		list([]);
		await unresolved(page).filter({ hasText: "This Host is not listed: devbox." }).waitFor();
		assert.equal(await composer(page).count(), 0, "the Session's view unmounted");
	});

	test(`session route app (${engine}): a link blip keeps the Session's view mounted and its draft`, { skip: engineSkip(engine) }, async (t) => {
		const { page, list } = await open(t, engine);
		await page.goto(`${ORIGIN}/${ROUTE}`);
		await composer(page).fill("half a thought");
		const mounted = await composer(page).elementHandle();
		// The hosts frame lists every link in every status, so resolution holds through the blip.
		list([{ ...PI, status: "disconnected", since: 0, error: "connection reset", hint: "retrying" }]);
		await page.waitForTimeout(300);
		list([{ ...PI, status: "connecting", phase: "transport", since: 0, hint: "connecting" }]);
		await page.waitForTimeout(300);
		list([PI]);
		await page.waitForTimeout(300);
		assert.equal(await unresolved(page).count(), 0, "the route stayed resolved");
		assert.equal(await mounted!.evaluate((el) => el.isConnected), true, "the composer was not unmounted and remounted");
		assert.equal(await composer(page).inputValue(), "half a thought", "the draft is kept");
	});

	test(`session route app (${engine}): a Pi thread on a Host the hub has not listed waits for it`, { skip: engineSkip(engine) }, async (t) => {
		const { page, frames, list } = await open(t, engine, { hosts: [] });
		await page.goto(`${ORIGIN}/${ROUTE}`);
		await unresolved(page).filter({ hasText: "This Host is not listed: devbox." }).waitFor();
		assert.equal(await composer(page).count(), 0, "no Session view without its Host");
		assert.deepEqual(frames.filter((f) => f.t === "sub" && f.topic?.kind === "thread"), [], "no thread subscribed");
		list([PI]);
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
