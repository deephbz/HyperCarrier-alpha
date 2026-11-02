import "./bound.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type WebSocketRoute } from "playwright";
import { loadBudget, PAGE_LOAD_MS } from "./page-load.ts";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: browser discovery is shared ESM.
import { findChrome } from "../scripts/perf/browser.mjs";

// The real browser host store (client.ts) under React: two consumers of useHosts and usePins, a fake hub on the
// page's WebSocket, and a counter around hub.subscribeHosts. No Host connection or owner data.
test("host store: hub frames reach every consumer, and unrelated rerenders keep each subscription", async () => {
	const web = fileURLToPath(new URL("../web", import.meta.url));
	const entry = join(web, "host-store-subscribe-test.js");
	const result = await build({ configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' }, plugins: [react(), {
		name: "host-store-subscribe-test", resolveId: (id) => id === entry ? `\0${entry}` : undefined,
		load: (id) => id === `\0${entry}` ? `
			import React from 'react'; import {createRoot} from 'react-dom/client';
			import {hub, useHosts, usePins} from ${JSON.stringify(join(web, "src/client.ts"))};
			const counts = window.counts = {add: 0, remove: 0};
			const subscribe = hub.subscribeHosts.bind(hub);
			hub.subscribeHosts = (listener) => { counts.add++; const off = subscribe(listener); return () => { counts.remove++; return off(); }; };
			const h = React.createElement;
			function Consumer({name}) {
				const {hosts, connected, listed} = useHosts(); const pins = usePins();
				return h('p', {id: name}, [connected, listed, hosts.map((x) => x.link).join(','), pins.map((p) => p.threadId).join(',')].join(' | '));
			}
			function App() {
				const [tick, setTick] = React.useState(0); window.rerender = () => setTick((t) => t + 1);
				return h('div', {'data-tick': tick}, h(Consumer, {name: 'a'}), h(Consumer, {name: 'b'}));
			}
			createRoot(document.getElementById('root')).render(h(App));
		` : undefined,
	}], build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "HostStoreSubscribeTest" } } });
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	const script = output.output.find((x) => x.type === "chunk")!.code!;
	const browser = await chromium.launch({ headless: true, executablePath: findChrome() });
	try {
		const page = await browser.newPage();
		page.setDefaultTimeout(2000);
		loadBudget(page);
		let socket: WebSocketRoute | undefined;
		await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script>${script}</script>` }));
		await page.routeWebSocket("**/ws", (ws) => { socket = ws; });
		await page.goto("http://localhost/");
		const text = async () => [await page.locator("#a").textContent(), await page.locator("#b").textContent()];
		const both = async (line: string) => { await page.locator("#b", { hasText: line }).waitFor({ timeout: PAGE_LOAD_MS }); assert.deepEqual(await text(), [line, line]); };
		await both("true | false |  | ");
		// Two consumers, each with three host snapshots and one pin snapshot.
		const counts = () => page.evaluate(() => ({ ...(window as any).counts }));
		assert.deepEqual(await counts(), { add: 8, remove: 0 });
		socket!.send(JSON.stringify({ t: "hosts", hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", status: "connected", attempts: 0 }] }));
		await both("true | true | devbox | ");
		for (let i = 1; i <= 20; i++) {
			await page.evaluate(() => (window as any).rerender());
			await page.locator(`[data-tick="${i}"]`).waitFor();
		}
		assert.deepEqual(await counts(), { add: 8, remove: 0 }, "an unrelated rerender re-subscribed");
		socket!.send(JSON.stringify({ t: "pins", pins: [{ host: "devbox", threadId: "pi:sess-a", title: "A" }] }));
		await both("true | true | devbox | pi:sess-a");
		assert.deepEqual(await counts(), { add: 8, remove: 0 });
	} finally {
		await browser.close();
	}
});
