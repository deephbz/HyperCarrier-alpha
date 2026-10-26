import "./bound.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { Hub } from "../src/hub/hub.ts";
import { arrangeByLayout } from "../web/src/components/sidebar-layout.ts";
import { href, threadRef } from "../web/src/util.ts";
import { Browser, tempHome } from "./helpers.ts";
import { fixture } from "./pi-fixtures.ts";
import { HELPER_MODELS, TOKEN, assistant, iso, line, user } from "./pi-host-fixtures.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

test("hub mixed hosts: one Host ID carries a Pi source and a durable source; link keys route each; a bare ID served by both resolves by thread prefix or is refused", async (t) => {
	const f = fixture();
	writeFileSync(f.sessionA, line({ type: "session", version: 3, id: "sess-a", timestamp: iso(0), cwd: "/work" }) + user("u1", null, 1, "list the files") + assistant("a1", "u1", 2, "Listing."));
	const home = tempHome();
	const daemon = await runDaemon({ home });
	const pi = {
		id: "devbox", label: "devbox", kind: "pi-local" as const, cacheDir: join(f.dir, "cache"),
		agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false, controlStatusMs: 300 },
		env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") },
	};
	const hub = new Hub({ hosts: [pi, { id: "devbox", label: "devbox", kind: "local", home }], models: HELPER_MODELS }, { token: TOKEN });
	const port = await hub.listen(0);
	const b = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	t.after(async () => { b.ws.terminate(); await hub.close(); await daemon.stop(); });

	await b.when(() => b.hosts.filter((h) => h.status === "connected").length === 2, 10_000, "both sources");
	assert.deepEqual(b.hosts.map((h) => [h.id, h.link]).sort(), [["devbox", "devbox#durable"], ["devbox", "devbox#pi"]]);

	// A bare Host ID that two sources serve is not a route: requests and subscriptions are refused, never guessed.
	await assert.rejects(b.req("devbox", "sessions.search", { query: "files" }), (e: any) => e.code === "ambiguous_host" && /devbox#pi or devbox#durable|devbox#durable or devbox#pi/.test(e.message));
	const bare = b.sub("devbox", { kind: "threads" });
	await b.when(() => b.closing.get(bare)?.t === "end", 5000, "bare sub ended");
	assert.match(b.closing.get(bare)!.reason, /two sources/);
	// A Host that no source serves keeps its own words: the page names "Unknown host", a request says it is unknown.
	const gone = b.sub("gone-host", { kind: "thread", threadId: "pi:sess-a" });
	await b.when(() => b.closing.get(gone)?.t === "end", 5000, "gone-host sub ended");
	assert.equal(b.closing.get(gone)!.reason, "Unknown host gone-host");
	await assert.rejects(b.req("gone-host", "sessions.search", { query: "files" }), (e: any) => e.code === "host_unavailable" && e.message === "Host gone-host is unknown");

	// Each link key reaches its own source.
	const { threadId } = await b.req("devbox#durable", "thread.create", { requestId: "mix", cwd: home, model: SIM, prompt: "Hello", place: { workspace: "new", label: "main" } });
	const durable = await b.until<any>(b.sub("devbox#durable", { kind: "threads" }), (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].ref);
	const piList = await b.until<any>(b.sub("devbox#pi", { kind: "threads" }), (v) => v.threads["pi:sess-a"]);
	assert.equal(durable.threads[threadId].ref, `devbox/pi-durable:${threadId}`);
	assert.equal(piList.threads["pi:sess-a"].ref, "devbox/pi:sess-a");
	assert.equal(durable.threads["pi:sess-a"], undefined, "the durable list holds no Pi Session");
	assert.equal(piList.threads[threadId], undefined, "the Pi list holds no durable thread");

	// Both citation forms open their own source: an old `<host>/pi:<id>` keeps reaching the Pi Session.
	for (const row of [durable.threads[threadId], piList.threads["pi:sess-a"]]) {
		const target = decodeURIComponent(href.ref(row.ref)!);
		const [, link, thread] = /^#\/h\/([^/]+)\/t\/([^?]+)/.exec(target)!;
		assert.equal(threadRef(link!, thread!), row.ref, "the route maps back to the same citation");
		const value = await b.until<any>(b.sub(link!, { kind: "thread", threadId: thread }), (v) => Array.isArray(v.entries) && v.entries.length > 0);
		assert.equal(value.entries.some((e: any) => e.kind === "user"), true, `${row.ref} opened ${link}`);
	}
	assert.equal(decodeURIComponent(href.ref("devbox/pi:sess-a#a1")!), "#/h/devbox#pi/t/pi:sess-a?e=a1");
	assert.equal(decodeURIComponent(href.ref(`devbox/pi-durable:${threadId}#7`)!), `#/h/devbox#durable/t/${threadId}?e=7`);

	// One source per Host ID still resolves the bare ID (older links, single-source configs).
	assert.equal(hub.route("devbox#pi").hasOwnProperty("key"), true);
	assert.deepEqual(hub.route("devbox"), { error: { code: "ambiguous_host", message: "Host devbox has two sources; name devbox#pi or devbox#durable" } });
	// A saved bare-ID link names its source by the thread ID's prefix.
	assert.deepEqual(hub.route("devbox", "pi:sess-a"), { key: "devbox#pi" });
	assert.deepEqual(hub.route("devbox", threadId), { key: "devbox#durable" });
	const viaBare = await b.until<any>(b.sub("devbox", { kind: "thread", threadId: "pi:sess-a" }), (v) => Array.isArray(v.entries) && v.entries.length > 0);
	assert.equal(viaBare.entries.some((e: any) => e.kind === "user"), true, "a bare-ID thread subscription reaches the Pi Session");
	const entry = await b.req("devbox", "thread.entry", { threadId, entryId: durable.threads[threadId].lastEntryId ?? "0" }).catch((e: any) => e);
	assert.notEqual(entry?.code, "ambiguous_host", "a bare-ID request with a durable thread ID reaches the durable source");
	assert.deepEqual(b.gaps, []);
});

test("durable tabs in the sidebar: a tab is one group in tab order, its label shows once, and a closed thread is unplaced", () => {
	const row = (id: string, tab?: { id: string; label: string }) => ({ id, title: id, updatedAt: 1, ...(tab ? { location: { workspace: tab.id, workspaceLabel: tab.label, tab: tab.id, tabLabel: tab.label } } : {}) });
	const main = { id: "tab-1", label: "main" };
	const side = { id: "tab-2", label: "side" };
	const threads = [row("s.3", main), row("s.1", main), row("s.2", side), row("s.4")] as never;
	const layout = { workspaces: [{ id: "tab-1", label: "main", tabs: [{ id: "tab-1", label: "main", panes: ["s.1", "s.3"] }] }, { id: "tab-2", label: "side", tabs: [{ id: "tab-2", label: "side", panes: ["s.2"] }] }] };
	const { groups, unplaced } = arrangeByLayout({ threads, layout });
	assert.deepEqual(groups.map((g) => [g.label, g.rows.map((r) => r.id)]), [["main", ["s.1", "s.3"]], ["side", ["s.2"]]]);
	assert.deepEqual(unplaced.map((r) => r.id), ["s.4"]);
});
