import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { Hub } from "../src/hub/hub.ts";
import type { HostState as HubHostState } from "../src/hub/hosts.ts";
import { findHost, hostLabel, hostLabelFor } from "../web/src/components/host-label.ts";
import { Browser, ownHome, tempHome } from "./helpers.ts";
import { fixture } from "./pi-fixtures.ts";
import { HELPER_MODELS, TOKEN, assistant, iso, line, user } from "./pi-host-fixtures.ts";

test("hub host links: one Host ID carries a Pi source and a durable source; link keys route each; a bare ID served by both resolves by thread prefix or is refused (failure: main keyed links by Host ID and dropped one source)", async (t) => {
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
	await assert.rejects(b.req("devbox", "sessions.search", { query: "files" }), (e: any) => e.code === "ambiguous_host" && /two sources/.test(e.message));
	const bare = b.sub("devbox", { kind: "threads" });
	await b.when(() => b.closing.get(bare)?.t === "end", 5000, "bare sub ended");
	assert.match(b.closing.get(bare)!.reason, /two sources/);
	// A Host that no source serves keeps its own words.
	const gone = b.sub("gone-host", { kind: "thread", threadId: "pi:sess-a" });
	await b.when(() => b.closing.get(gone)?.t === "end", 5000, "gone-host sub ended");
	assert.equal(b.closing.get(gone)!.reason, "Unknown host gone-host");
	await assert.rejects(b.req("gone-host", "sessions.search", { query: "files" }), (e: any) => e.code === "host_unavailable" && e.message === "Host gone-host is unknown");

	// Each link key reaches its own source.
	const piList = await b.until<any>(b.sub("devbox#pi", { kind: "threads" }), (v) => v.threads["pi:sess-a"]);
	assert.equal(piList.threads["pi:sess-a"].ref, "devbox/pi:sess-a");
	const durable = await b.until<any>(b.sub("devbox#durable", { kind: "threads" }), (v) => v.threads !== undefined);
	assert.equal(durable.threads["pi:sess-a"], undefined, "the durable list holds no Pi Session");

	// A saved bare-ID link names its source by the thread ID's prefix.
	assert.deepEqual(hub.route("devbox#pi"), { key: "devbox#pi" });
	assert.deepEqual(hub.route("devbox", "pi:sess-a"), { key: "devbox#pi" });
	assert.deepEqual(hub.route("devbox", "t-1"), { key: "devbox#durable" });
	const viaBare = await b.until<any>(b.sub("devbox", { kind: "thread", threadId: "pi:sess-a" }), (v) => Array.isArray(v.entries) && v.entries.length > 0);
	assert.equal(viaBare.entries.some((e: any) => e.kind === "user"), true, "a bare-ID thread subscription reaches the Pi Session");
	assert.deepEqual(b.gaps, []);
});

test("hub host links: a thread frame resolves only to the thread's own source, also when the Host ID has one source (failure: a lone durable source took a Pi thread, so an old client got the wrong source's not-found)", async (t) => {
	const home = tempHome();
	const hub = new Hub({ hosts: [{ id: "devbox", label: "devbox", kind: "local", home }] }, { token: TOKEN });
	const port = await hub.listen(0);
	const b = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	t.after(async () => { b.ws.terminate(); await hub.close(); });

	assert.deepEqual(hub.route("devbox"), { key: "devbox#durable" }, "without a thread, one source serves the Host ID");
	assert.deepEqual(hub.route("devbox", "t-1"), { key: "devbox#durable" });
	assert.deepEqual(hub.route("devbox", "pi:sess-a"), { error: { code: "source_unavailable", message: "Host devbox has no pi source for thread pi:sess-a" } });
	const piThread = b.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
	await b.when(() => b.closing.get(piThread)?.t === "end", 5000, "Pi thread sub ended");
	assert.equal(b.closing.get(piThread)!.reason, "Host devbox has no pi source for thread pi:sess-a");
	await assert.rejects(b.req("devbox", "thread.get", { threadId: "pi:sess-a" }), (e: any) => e.code === "source_unavailable");
});

test("hub host links: removing one source of a shared Host ID keeps the other in hub.json and in the hub (failure: remove filtered hub.json by Host ID); the hosts frame names the hub.json for the setup prompt", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-links-")), file = join(dir, "hub.json");
	const hosts = [{ id: "linuxbox", label: "linuxbox", kind: "pi-ssh", target: "linuxbox.invalid" }, { id: "linuxbox", label: "linuxbox", kind: "ssh", target: "linuxbox.invalid" }];
	writeFileSync(file, JSON.stringify({ hosts }));
	const home = ownHome(dir);
	const hub = new Hub({ hosts: structuredClone(hosts) as never }, { configPath: file, token: TOKEN, home });
	const port = await hub.listen(0);
	try {
		const browser = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
		await browser.when(() => browser.config !== undefined, 5000, "hosts frame");
		assert.equal(browser.config, file);
		const removed = await new Promise<any>((resolve) => {
			browser.ws.on("message", (data) => { const frame = JSON.parse(String(data)); if (frame.t === "res" && frame.id === 7) resolve(frame); });
			browser.ws.send(JSON.stringify({ t: "hub", id: 7, op: "hosts.remove", args: { id: "linuxbox#pi" } }));
		});
		assert.equal(removed.ok, true, JSON.stringify(removed));
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hosts.map((h: any) => h.kind), ["ssh"]);
		assert.deepEqual(hub.hostStates().map((h) => h.link), ["linuxbox#durable"]);
		browser.ws.close();
	} finally {
		await hub.close();
		home.release();
	}
});

test("web host routing: findHost takes a link key or a single-source Host ID, and a thread prefix picks the source of a shared ID; labels name the source only when the ID is shared", () => {
	type HostState = HubHostState & { link: string };
	const host = (id: string, kind: HostState["kind"], link: string) => ({ id, label: id, kind, status: "connected", link }) as HostState;
	const hosts = [host("mac", "pi-local", "mac#pi"), host("mac", "local", "mac#durable"), host("linuxbox", "pi-ssh", "linuxbox#pi")];
	assert.equal(findHost(hosts, "linuxbox")?.link, "linuxbox#pi");
	assert.equal(findHost(hosts, "mac#durable")?.kind, "local");
	assert.equal(findHost(hosts, "mac"), undefined, "a shared ID without a thread names no source");
	assert.equal(findHost(hosts, "mac", "pi:s1")?.link, "mac#pi");
	assert.equal(findHost(hosts, "mac", "t-1")?.link, "mac#durable");
	assert.equal(findHost(hosts, "linuxbox", "pi:s1")?.link, "linuxbox#pi");
	assert.equal(findHost(hosts, "linuxbox", "t-1"), undefined, "a thread resolves only to its own source");
	assert.equal(hostLabel(hosts[0]!, hosts), "mac · Pi in Herdr");
	assert.equal(hostLabel(hosts[2]!, hosts), "linuxbox");
	assert.equal(hostLabelFor("gone#pi", hosts), "gone");
});
