import "./bound.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, type TestContext } from "node:test";
import { chromium, webkit, type WebSocketRoute } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import { runDaemon } from "../src/node/daemon.ts";
import type { NodeOptions, NodePlugin } from "../src/node/runtime.ts";
import { Hub } from "../src/hub/hub.ts";
import { Browser, tempHome } from "./helpers.ts";

export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

export async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("No held node receipt within 1500 ms")), 1500); })]); }
	finally { clearTimeout(timer); }
}

// Bundle the actual component in memory. Only the page shell is a fixture; command discovery,
// Enter handling, WebSocket traffic, the hub, and the node all run their production code.
async function componentScript(): Promise<string> {
	const root = fileURLToPath(new URL("../web", import.meta.url));
	const entry = join(root, "composer-test-entry.js");
	const result = await build({
		configFile: false, root, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "composer-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { Composer } from ${JSON.stringify(join(root, "src/components/Composer.tsx"))};
				import { useHosts, useTopic } from ${JSON.stringify(join(root, "src/client.ts"))};
				function Fixture() {
					const { connected } = useHosts();
					const [threadId, switchThread] = React.useState(new URLSearchParams(location.search).get('thread'));
					window.switchThread = switchThread;
					const { value: view } = useTopic('devbox', { kind: 'thread', threadId });
					const { value: threads } = useTopic('devbox', { kind: 'threads' });
					const [panel, setPanel] = React.useState();
					const [panelCalls, setPanelCalls] = React.useState(0);
					if (!view || !connected) return null;
					return React.createElement(React.Fragment, null,
						...Object.keys(threads?.threads ?? {}).map(id => React.createElement('button', { key: id, onClick: () => switchThread(id) }, 'Thread ' + id)),
						React.createElement('output', { 'data-panel': true }, panel ?? 'none'),
						React.createElement('output', { 'data-panel-calls': true }, panelCalls),
						React.createElement('button', { onClick: () => setPanel(undefined) }, 'Close panel'),
						React.createElement(Composer, {
						// ThreadView keeps one Composer across threads; \`unkeyed\` models that.
						key: new URLSearchParams(location.search).has('unkeyed') ? undefined : threadId, host: 'devbox', threadId,
						pi: new URLSearchParams(location.search).has('pi'),
						view,
						// \`summary\` passes the thread's row, as ThreadView does; other tests keep the summaryless composer.
						...(new URLSearchParams(location.search).has('summary') ? { summary: threads?.threads?.[threadId] } : {}),
						models: [], actions: { panel, openPanel(name) { setPanelCalls(n => n + 1); setPanel(name); } }
					}));
				}
				createRoot(document.getElementById('root')).render(React.createElement(Fixture));
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "ComposerTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}

let bundle: Promise<string> | undefined;
const browsers = new Map<string, ReturnType<typeof chromium.launch>>();
after(async () => { await Promise.all([...browsers.values()].map(async (browser) => (await browser).close())); });
export async function fixture(t: TestContext, simTokensPerSecond = 100_000, pi = false, holdQueueAck = false, transport?: (client: WebSocketRoute) => void, nodeOptions: { transport?: (socket: Socket) => void; prompts?: Record<string, string>; plugins?: NodePlugin[]; models?: NodeOptions["models"]; stopWaitMs?: number } = {}, browserName: "chromium" | "webkit" = "chromium") {
	const script = await (bundle ??= componentScript());
	const home = tempHome();
	const cleanup: (() => unknown | Promise<unknown>)[] = [() => rmSync(home, { recursive: true, force: true })];
	t.after(async () => { for (const close of cleanup.reverse()) await close(); });
	const agentDir = join(home, "agent");
	if (nodeOptions.prompts) {
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		for (const [name, body] of Object.entries(nodeOptions.prompts)) writeFileSync(join(agentDir, "prompts", `${name}.md`), body);
	}
	const daemon = await runDaemon({ home, simTokensPerSecond, plugins: nodeOptions.plugins, ...(nodeOptions.models ? { models: nodeOptions.models } : {}), ...(nodeOptions.stopWaitMs ? { stopWaitMs: nodeOptions.stopWaitMs } : {}), ...(nodeOptions.prompts ? { agentDir } : {}) });
	if (nodeOptions.transport) daemon.server.on("connection", nodeOptions.transport);
	cleanup.push(() => daemon.stop());
	const token = "e".repeat(64);
	const hub = new Hub({ hosts: [{ id: "devbox", label: "Workbench", kind: "local", home }] }, { token });
	const port = await hub.listen(0);
	cleanup.push(() => hub.close());
	const wire = await Browser.open(port, undefined, `ampi_k_${port}=${token}`);
	cleanup.push(() => wire.ws.terminate());
	await wire.when(() => wire.hosts.some((h) => h.id === "devbox" && h.status === "connected"), 2000);
	const { threadId } = await wire.req("devbox", "thread.create", {
		requestId: "composer-audit", cwd: home, model: { provider: "ampi-sim", modelId: "sim-1" }, place: { workspace: "new", label: "main" },
	});
	const browserType = browserName === "webkit" ? webkit : chromium;
	const browser = await (browsers.get(browserName) ?? (async () => {
		const launched = browserType.launch({ headless: true, ...(browserName === "chromium" ? { executablePath: findChrome() } : {}) });
		browsers.set(browserName, launched);
		return launched;
	})());
	const page = await browser.newPage();
	cleanup.push(() => page.context().close());
	page.setDefaultTimeout(1500);
	const origin = `http://127.0.0.1:${port}`;
	// The intercepted page shell needs permission to reach its disposable loopback hub in Chrome.
	if (browserName === "chromium") await page.context().grantPermissions(["local-network-access"], { origin });
	await page.context().addCookies([{ name: `ampi_k_${port}`, value: token, url: origin }]);
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== origin) return route.abort();
		if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
		if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<meta charset="utf-8"><div id="root"></div><script src="/component.js"></script>' });
		return route.abort();
	});
	if (transport) await page.routeWebSocket("**/ws", transport);
	if (holdQueueAck) await page.routeWebSocket("**/ws", (client) => {
		const server = client.connectToServer();
		let first: number | undefined, second: number | undefined, held: string | Buffer | undefined;
		let lostSecondReply = false;
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.op === "thread.submit" && frame.args.content === "First queued text") first = frame.id;
			if (frame.op === "thread.submit" && frame.args.content === "Second queued text") second = frame.id;
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(String(message));
			// Keep the first admission reply in flight while the next real input reaches the node.
			// Subscription updates still flow. The second reply releases both acknowledgements.
			if (frame.t === "res" && frame.id === first) { held = message; return; }
			if (frame.t === "res" && frame.id === second) {
				if (held !== undefined) { client.send(held); held = undefined; }
				if (!lostSecondReply) {
					lostSecondReply = true;
					// The node admitted this input. Model a lost acknowledgement without waiting for the real timeout.
					client.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: "timeout", message: "Admission reply lost in test transport" } }));
					return;
				}
			}
			client.send(message);
		});
	});
	const sent: { id?: number; op?: string; args?: any }[] = [];
	const errors: string[] = [];
	const received: any[] = [];
	const changed = new Set<() => void>();
	const frameWhen = (find: () => any, label: string) => new Promise<any>((resolve, reject) => {
		const check = () => {
			const frame = find();
			if (frame) { clearTimeout(timer); changed.delete(check); resolve(frame); }
		};
		const timer = setTimeout(() => {
			changed.delete(check);
			reject(new Error(`No ${label}; last state: ${JSON.stringify({ sent: sent.filter((f) => f.op), replies: received.filter((f) => f.t === "res") })}`));
		}, 1500);
		changed.add(check);
		check();
	});
	const reply = (id: number, code?: string) => frameWhen(() => received.find((f) => f.t === "res" && f.id === id && (!code || f.error?.code === code)), `reply for request ${id}${code ? ` with ${code}` : ""}`);
	const submit = (index: number) => frameWhen(() => sent.filter((f) => f.op === "thread.submit")[index], `submit at index ${index}`);
	// CDP can report the upstream frame before a WebSocket route changes it. Observe what the UI receives.
	await page.exposeFunction("recordComposerFrame", (frame: any) => { received.push(frame); for (const check of changed) check(); });
	await page.addInitScript(() => {
		const NativeSocket = window.WebSocket;
		window.WebSocket = class extends NativeSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				this.addEventListener("message", (event) => { void (window as any).recordComposerFrame(JSON.parse(String(event.data))); });
			}
		};
	});
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => { sent.push(JSON.parse(String(payload))); for (const check of changed) check(); });
		socket.on("socketerror", (message) => errors.push(message));
	});
	await page.goto(`${origin}/?thread=${encodeURIComponent(threadId)}${pi ? "&pi=1" : ""}`);
	const input = page.getByRole("textbox", { name: "Message the agent" });
	await input.waitFor().catch((error) => { throw new Error(`${error.message}; page errors: ${JSON.stringify(errors)}; frames: ${JSON.stringify(received)}`); });
	const enter = async (text: string) => { await input.fill(text); await input.press("Enter"); };
	return { home, daemon, wire, threadId, page, input, enter, sent, received, reply, submit, errors, origin };
}
