import "./bound.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser } from "playwright";
import { build } from "vite";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import { engineSkip } from "./engines.ts";

// A hub served over http from a LAN address gives the page an insecure context, where the browser has no
// secure-context APIs such as its UUID minter. The real App, built in memory from web/src with its own vite config,
// loads from a non-loopback http origin, renders a Session's Composer, and sends a message under a version 4 request
// key from web/src/ids.ts. The hub is a script on the page's WebSocket.

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://ampi-lan.test";
const HOST = { id: "devbox", link: "devbox#durable", label: "devbox", kind: "durable", status: "connected" };
const THREAD = "c1";
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const view = { conversationId: THREAD, hiddenBefore: false, entries: [], live: {}, inbox: {}, agent: { cwd: "/work" }, usage: { costUsd: 0 } };
const thread = { id: THREAD, title: "Insecure origin", createdAt: 0, updatedAt: 0, kind: "thread", activity: "idle", queued: 0, costUsd: 0 };

async function appFiles() {
	const result = await build({ configFile: join(web, "vite.config.ts"), root: web, logLevel: "silent", build: { write: false, outDir: "dist" } });
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { fileName: string; type: string; code?: string; source?: string | Uint8Array }[] };
	const type = (name: string) => (name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
	return new Map(output.output.map((item) => [`/${item.fileName}`, { body: item.code ?? item.source!, type: type(item.fileName) }]));
}

let files: ReturnType<typeof appFiles> | undefined;
const browsers: Promise<Browser>[] = [];
after(async () => { for (const b of browsers) await (await b).close(); });

for (const engine of ["chromium", "webkit"] as const) {
	test(`insecure origin (${engine}): the App renders the Composer and sends under a v4 request key`, { skip: engineSkip(engine) }, async (t) => {
		const served = await (files ??= appFiles());
		const launched = engine === "webkit" ? webkit.launch({ headless: true }) : chromium.launch({ headless: true, executablePath: findChrome() });
		browsers.push(launched);
		const context = await (await launched).newContext({ viewport: { width: 1400, height: 800 } });
		t.after(() => context.close());
		const page = await context.newPage();
		page.setDefaultTimeout(20_000);
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.route("**/*", (route) => {
			const url = new URL(route.request().url());
			const file = url.origin === ORIGIN ? served.get(url.pathname === "/" ? "/index.html" : url.pathname) : undefined;
			return file ? route.fulfill({ status: 200, body: typeof file.body === "string" ? file.body : Buffer.from(file.body), contentType: file.type }) : route.abort();
		});
		const submits: { op: string; requestId?: string; content?: string }[] = [];
		await page.routeWebSocket("**/ws", (client) => {
			const send = (frame: unknown) => client.send(JSON.stringify(frame));
			send({ t: "hosts", hosts: [HOST] });
			client.onMessage((message) => {
				const frame = JSON.parse(String(message));
				if (frame.t === "sub") send({ t: "snap", sid: frame.sid, value: frame.topic?.kind === "thread" ? view : frame.topic?.kind === "threads" ? { threads: { [THREAD]: thread } } : {} });
				else if (frame.t === "req" && frame.args?.requestId) {
					submits.push({ op: frame.op, requestId: frame.args.requestId, content: frame.args.content });
					send({ t: "res", id: frame.id, ok: true, value: {} });
				} else if (frame.t === "req" || frame.t === "hub") send({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
			});
		});
		await page.goto(`${ORIGIN}/#/h/${encodeURIComponent(HOST.link)}/t/${THREAD}`);
		assert.deepEqual(await page.evaluate(() => ({ secure: window.isSecureContext, uuid: typeof (crypto as { randomUUID?: unknown }).randomUUID })), { secure: false, uuid: "undefined" }, "the page runs in an insecure context");
		const input = page.getByRole("textbox", { name: "Message the agent" });
		// A missing secure-context API throws while rendering; report that error, not the wait's timeout.
		await input.waitFor().catch((e) => { assert.deepEqual(errors, [], "no page error"); throw e; });
		await input.fill("Hello from the LAN");
		await input.press("Enter");
		for (let i = 0; i < 50 && submits.length < 1; i++) await page.waitForTimeout(100);
		assert.equal(submits.length, 1, `one send went out: ${JSON.stringify(submits)}`);
		assert.match(submits[0]!.requestId!, V4);
		assert.deepEqual(errors, [], "no page error");
	});
}
