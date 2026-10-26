import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { Hub } from "../src/hub/hub.ts";
import { topics } from "../src/node/server.ts";
import { Browser, tempHome } from "./helpers.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { HeadDoc } from "@hypercarrier/pi-team-durable/authority";
import { MetaDoc, type NodePlugin } from "../src/node/runtime.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const TOKEN = "f".repeat(64);

test("durable team: the Team view reads Tasks and members from the node's Team authority in the Pi frame shape", async (t) => {
	const home = tempHome();
	const summarized = new Set<string>(), reacted = new Set<string>(), opened = new Set<string>();
	const witness: NodePlugin = {
		extensions: [],
		attach(store) { const original = store.conversation.bind(store); store.conversation = async (id, context) => { opened.add(store.threadKey(id)); return original(id, context); }; },
		summarize(store, id) { summarized.add(store.threadKey(id)); },
		react(store, id) { reacted.add(store.threadKey(id)); },
	};
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: [witness, ...await hydrate()] });
	const hub = new Hub({ hosts: [{ id: "devbox", label: "devbox", kind: "local", home }] }, { token: TOKEN });
	const port = await hub.listen(0);
	const b = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	t.after(async () => { b.ws.terminate(); await hub.close(); await daemon.stop(); });
	await b.when(() => b.hosts.some((h) => h.id === "devbox" && h.status === "connected"), 5000, "durable host");

	const { threadId } = await b.req("devbox", "thread.create", { requestId: "team", cwd: home, model: SIM, prompt: "/sim team Ship the endpoint", place: { workspace: "new", label: "main" } });
	const team = b.sub("devbox", { kind: "view", view: "team", threadId });
	const done = await b.until<any>(team, (v) => v.teams?.[0]?.members?.length === 3 && v.teams[0].tasks?.length === 3 && v.teams[0].tasks.every((x: any) => x.status === "goal_achieved"), 30_000);
	const [group] = done.teams;
	assert.equal(done.availability, "available");
	assert.equal(group.messages.availability, "available");
	assert.ok(group.messages.records.some((r: any) => r.kind === "delivery"), "the node message projection reaches the shared Team view");
	assert.ok(group.messages.records.some((r: any) => r.kind === "lead-update"));
	assert.deepEqual(group.issues, []);
	for (const task of group.tasks) assert.deepEqual(Object.keys(task).sort(), [...("owner" in task ? ["owner"] : []), "deps", "id", "ready", "status", "title"].sort());
	assert.deepEqual(group.tasks.find((x: any) => x.id === "docs").deps, ["api"]);
	assert.deepEqual(group.members.map((m: any) => m.role).sort(), ["lead", "worker", "worker"]);
	const lead = group.members.find((m: any) => m.role === "lead");
	assert.equal(lead.threadId, threadId);
	for (const m of group.members) assert.ok(m.threadId, `every member links its thread: ${JSON.stringify(m)}`);
	// Worker panes join the lead's tab through layout ops; the row copy applies them and keeps the lead's Team role.
	const rows = await b.until<any>(b.sub("devbox", { kind: "threads" }), (v) => Object.values(v.threads).filter((r: any) => r.kind === "worker").length === 2);
	assert.deepEqual(rows.threads[threadId].team, { teamId: threadId, role: "lead" });
	assert.deepEqual(rows.layout.workspaces.flatMap((w: any) => w.tabs.flatMap((tab: any) => tab.panes)).sort(), Object.keys(rows.threads).sort());
	assert.equal(Object.keys(rows.threads).length, 3);
	assert.equal(group.members.length, 3);
	const { store } = await daemon.runtime.thread(threadId);
	const head = await store.harness.snapshot(HeadDoc, BACKGROUND_CONTEXT);
	const log = String(JSON.parse(head!.value as string).log), logKey = store.threadKey(log);
	assert.ok((await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT))?.convs[log], "internal storage keeps its metadata");
	assert.equal(summarized.has(logKey), false);
	assert.equal(reacted.has(logKey), false);
	assert.equal(opened.has(logKey), false, "projection never opens the log to scan entries");
	await assert.rejects(daemon.runtime.thread(logKey), { code: "not_found" });
	await assert.rejects(daemon.runtime.closeThread(logKey), { code: "not_found" });
	assert.equal((await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT))?.convs[log].closed, undefined);
	assert.deepEqual(b.gaps, []);
});

test("durable team: a Team subscription end while connected shows the Team unavailable, then the next rows change recovers it", async (t) => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate() });
	// The node ends a subscription whose topic handler throws (server.ts #subscribe); the link stays connected.
	const real = topics.get("team")!;
	let failing = true;
	topics.set("team", async (topic, runtime) => { if (failing) throw new Error("team authority down"); return real(topic, runtime); });
	const hub = new Hub({ hosts: [{ id: "devbox", label: "devbox", kind: "local", home }] }, { token: TOKEN });
	const port = await hub.listen(0);
	const b = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	t.after(async () => { topics.set("team", real); b.ws.terminate(); await hub.close(); await daemon.stop(); });
	await b.when(() => b.hosts.some((h) => h.id === "devbox" && h.status === "connected"), 5000, "durable host");

	const { threadId } = await b.req("devbox", "thread.create", { requestId: "team-end", cwd: home, model: SIM, prompt: "/sim team Ship the endpoint", place: { workspace: "new", label: "main" } });
	const team = b.sub("devbox", { kind: "view", view: "team", threadId });
	const down = await b.until<any>(team, (v) => v.availability === "unavailable" && v.teams?.length === 1, 10_000);
	assert.deepEqual(down.teams[0].tasks, [], "an ended Team shows no stale Tasks");
	assert.equal(down.teams[0].messages.availability, "unavailable");
	assert.match(down.teams[0].messages.reason, /disconnected/);
	assert.ok(down.teams[0].issues.includes("task_authority_unavailable"));
	assert.deepEqual(down.teams[0].members.map((m: any) => [m.role, m.threadId]), [["lead", threadId]]);
	assert.equal(b.hosts.find((h) => h.id === "devbox")?.status, "connected");

	failing = false;
	await b.req("devbox", "thread.rename", { threadId, title: "Team end recovery" });
	const up = await b.until<any>(team, (v) => v.availability === "available" && v.teams?.[0]?.tasks?.length === 3, 10_000);
	assert.deepEqual(up.teams[0].issues, []);
});
