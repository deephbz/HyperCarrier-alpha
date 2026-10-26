import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableHost } from "../src/hub/durable-host.ts";
import { runDaemon } from "../src/node/daemon.ts";
import { ops } from "../src/node/server.ts";
import { projectEntry } from "../src/pi/projection.ts";
import { tempHome } from "./helpers.ts";

// A delivered Team input in a durable Worker transcript, through the transcript's notice row: its badge, author, and
// readable text come from the team.notice entry data and payload, never from the raw JSON the model reads.

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let notice: (props: object) => unknown;

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects.
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	notice = (await vite.ssrLoadModule("/src/components/ThreadView.tsx")).NoticeEntry;
});
after(async () => { await vite?.close(); });

const injected = (content: unknown) => ({ ref: "devbox/pi-durable:tree-a.8#7", id: "7", parent: "6", t: 1000, kind: "injected", role: "user", customType: "team.notice", text: JSON.stringify(content) });
const data = (delivery: string, more: object = {}) => ({ source: "team", deliveryId: "k1", epoch: "e1", delivery, sender: "team-lead", ...more });
const render = (entry: unknown) => renderToStaticMarkup(createElement(notice as never, { entry, host: "devbox#durable", threadId: "tree-a.8" }));
const summary = (html: string) => /<summary[^>]*>(.*?)<\/summary>/s.exec(html)![1]!;
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("team notice: an interrupt Alert shows the alert · interrupt badge, its author, and its text; the interruption outcome stays hidden", () => {
	const content = { kind: "alert", alert: { from: "reviewer", kind: "attention", text: "Stop the gate run\nThe lock is stale." }, interruption: { outcome: "interrupted", message: "The captured run was interrupted." } };
	const entry = projectEntry(injected(content) as never, { data: data("alert", { sender: "reviewer", interrupt: true }) }) as any;
	assert.deepEqual(entry.message, { kind: "alert", label: "alert · interrupt", sender: "reviewer", text: "Stop the gate run\nThe lock is stale." });
	const html = render(entry);
	assert.match(html, /<span class="badge attn">alert · interrupt<\/span>/);
	assert.equal(words(summary(html)).replace(/ \d\d:\d\d.*$/, ""), "alert · interrupt reviewer Stop the gate run");
	assert.match(words(html), /The lock is stale\./);
	assert.doesNotMatch(html, /\{&quot;kind|\{"kind|interrupted|captured run/, "neither the JSON nor the interruption outcome reaches the owner");
	const plain = projectEntry(injected({ kind: "alert", alert: { text: "Check the gate" } }) as never, { data: data("alert", { sender: "reviewer" }) }) as any;
	assert.equal(plain.message.label, "alert", "an ordinary Alert keeps the plain badge");
});

test("team notice: a Task, a stop, and an update read as Team notices with readable text, never as owner messages", () => {
	const task = projectEntry(injected({ kind: "task", task: { id: "t1", title: "Fix the reader", goal: "Read the durable copy." } }) as never, { data: data("task") }) as any;
	assert.equal(task.kind, "custom");
	assert.deepEqual(task.message, { kind: "team-update", label: "task", sender: "team-lead", text: "Fix the reader\n\nRead the durable copy." });
	const stop = projectEntry(injected({ kind: "task_changed", task_id: "t1", message: "The previous Attempt was superseded or cancelled." }) as never, { data: data("stop") }) as any;
	assert.deepEqual(stop.message, { kind: "team-update", label: "task changed", sender: "team-lead", text: "Attempt superseded; re-read Task t1\n\nThe previous Attempt was superseded or cancelled." });
	const update = projectEntry(injected({ kind: "team_update", page_id: "e1:notify:1:1", result: {} }) as never, { data: { source: "team", pageId: "e1:notify:1:1", epoch: "e1", delivery: "update", sender: "durable-team" } }) as any;
	assert.equal(update.message.label, "team update");
	assert.equal(words(summary(render(update))).replace(/ \d\d:\d\d.*$/, ""), "team update durable-team Team update", "the first line names the update; its JSON stays in the collapsed body");
	for (const entry of [task, stop]) assert.doesNotMatch(render(entry), /\{&quot;kind|\{"kind/);
});

test("team notice: an entry without Team data keeps the generic notice shape", () => {
	const entry = projectEntry(injected({ kind: "alert", alert: { text: "x" } }) as never) as any;
	assert.equal(entry.message.label, "team.notice");
	const foreign = projectEntry(injected({ kind: "alert", alert: { text: "x" } }) as never, { data: { source: "other" } }) as any;
	assert.equal(foreign.message.label, "team.notice", "data from another producer is not a Team origin");
});

test("team notice: an update or older notice fences its text as JSON only when the text is JSON; prose stays prose", () => {
	const update = { source: "team", pageId: "e1:notify:1:1", epoch: "e1", delivery: "update", sender: "durable-team" };
	const prose = { ...injected(""), text: "Two Workers finished.\nReview the batch." };
	assert.equal((projectEntry(prose as never, { data: update }) as any).message.text, "Team update\n\nTwo Workers finished.\nReview the batch.");
	const json = projectEntry(injected({ kind: "team_update", result: {} }) as never, { data: update }) as any;
	assert.equal(json.message.text, 'Team update\n\n```json\n{"kind":"team_update","result":{}}\n```');
});

const turn = () => new Promise((r) => setImmediate(r));
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 20_000; i++) { if (ok()) return; await turn(); } assert.fail(`never: ${what}`); };

test("team notice: without a hub copy, the composed Host's thread value names the origin, and the row renders", { timeout: 20_000 }, async (t) => {
	const home = tempHome();
	const daemon = await runDaemon({ home });
	const host = new DurableHost({ id: "devbox", label: "devbox", kind: "local", home });
	t.after(async () => { await host.stop(); await daemon.stop(); });
	host.start();
	await until(() => host.state.status === "connected", "connected");
	const { threadId } = await ops.get("thread.create")!({ requestId: "tn", cwd: tempHome(), model: { provider: "ampi-sim", modelId: "sim-1" }, prompt: "Hello", place: { workspace: "new", label: "main" } }, daemon.runtime) as { threadId: string };
	const { conversation } = await (daemon.runtime as any).thread(threadId);
	const content = JSON.stringify({ kind: "alert", alert: { from: "reviewer", text: "Stop the gate run" }, interruption: { outcome: "interrupted", message: "The captured run was interrupted." } });
	const sent = await conversation.submit({ type: "input", content, whenBusy: "steer", entry: { kind: "team.notice", data: data("alert", { sender: "reviewer", interrupt: true }) } }, BACKGROUND_CONTEXT);
	await sent.wait(BACKGROUND_CONTEXT);
	// No hub copy: the reader cannot parse the ID, so the node's full value is the thread value (durable-host.ts #value).
	Object.assign(host.views, { has: () => false, threadValue: () => undefined });
	const snaps: any[] = [];
	host.on("frame", (f: any) => { if (f.t === "snap" && f.sid === 1) snaps.push(f.value); });
	host.send({ t: "sub", sid: 1, topic: { kind: "thread", threadId } } as never);
	await until(() => snaps.length > 0, "thread snapshot");
	const entry = snaps[0].entries.find((e: any) => e.entryKind === "team.notice");
	assert.deepEqual(entry?.message, { kind: "alert", label: "alert · interrupt", sender: "reviewer", text: "Stop the gate run" });
	const html = render(entry);
	assert.equal(words(summary(html)).replace(/ \d\d:\d\d.*$/, ""), "alert · interrupt reviewer Stop the gate run");
	assert.doesNotMatch(html, /\{&quot;kind|interrupted|captured run/);
});
