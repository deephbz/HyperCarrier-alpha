import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hub, loadHubConfig } from "../src/hub/hub.ts";
import type { HostState as HubHostState } from "../src/shared/hosts.ts";
import { DURABLE_RELEASE } from "../src/shared/protocol.ts";
import { findHost, hostLabelFor } from "../web/src/components/host-label.ts";
import { Browser, ownHome } from "./helpers.ts";
import { TOKEN, assistant, iso, line, setup, user } from "./pi-host-fixtures.ts";

test("hub host links: a Host ID and its link key route to the Pi source; a durable thread ID names the durable release and is never served (failure: a durable pin reached a Pi Host)", async (t) => {
	const { f, hub, browser: b } = await setup(t);
	writeFileSync(f.sessionA, line({ type: "session", version: 3, id: "sess-a", timestamp: iso(0), cwd: "/work" }) + user("u1", null, 1, "list the files") + assistant("a1", "u1", 2, "Listing."));
	await b.when(() => b.hosts.some((h) => h.status === "connected"), 10_000, "the Pi Host");
	assert.deepEqual(b.hosts.map((h) => [h.id, h.link]), [["devbox", "devbox#pi"]]);

	assert.deepEqual(hub.route("devbox#pi"), { key: "devbox#pi" });
	assert.deepEqual(hub.route("devbox", "pi:sess-a"), { key: "devbox#pi" });
	assert.deepEqual(hub.route("devbox", "t-1"), { error: { code: "source_unavailable", message: "Host devbox serves Pi Sessions only; thread t-1 needs the durable release" } });
	const viaBare = await b.until<any>(b.sub("devbox", { kind: "thread", threadId: "pi:sess-a" }), (v) => Array.isArray(v.entries) && v.entries.length > 0);
	assert.equal(viaBare.entries.some((e: any) => e.kind === "user"), true, "a bare-ID thread subscription reaches the Pi Session");

	const durable = b.sub("devbox", { kind: "thread", threadId: "t-1" });
	await b.when(() => b.closing.get(durable)?.t === "end", 5000, "durable sub ended");
	assert.match(b.closing.get(durable)!.reason, /needs the durable release/);
	await assert.rejects(b.req("devbox", "thread.get", { threadId: "t-1" }), (e: any) => e.code === "source_unavailable");

	// A Host that no source serves keeps its own words.
	const gone = b.sub("gone-host", { kind: "thread", threadId: "pi:sess-a" });
	await b.when(() => b.closing.get(gone)?.t === "end", 5000, "gone-host sub ended");
	assert.equal(b.closing.get(gone)!.reason, "Unknown host gone-host");
	await assert.rejects(b.req("gone-host", "sessions.search", { query: "files" }), (e: any) => e.code === "host_unavailable" && e.message === "Host gone-host is unknown");
	assert.deepEqual(b.gaps, []);
});

test("hub.json with a local row, an ssh row and a Pi row: the hub starts and serves the Pi Hosts, the hosts frame names the skipped rows and the hub.json, and a remove keeps the skipped rows in the file (failure: main dropped or served durable rows)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-links-")), file = join(dir, "hub.json");
	const rows = [
		{ id: "linuxbox", label: "linuxbox", kind: "pi-ssh", target: "linuxbox.invalid" },
		{ id: "mac", label: "mac", kind: "local", home: join(dir, "durable") },
		{ id: "linuxbox", label: "linuxbox", kind: "ssh", target: "linuxbox.invalid" },
	];
	writeFileSync(file, JSON.stringify({ self: "box", hosts: rows }));
	const config = loadHubConfig(file);
	const home = ownHome(dir);
	const hub = new Hub({ ...config, hosts: config.hosts.filter((h) => h.kind === "pi-ssh") }, { configPath: file, token: TOKEN, home });
	const port = await hub.listen(0);
	try {
		const browser = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
		await browser.when(() => browser.config !== undefined, 5000, "hosts frame");
		assert.equal(browser.config, file);
		assert.deepEqual(browser.hosts.map((h) => h.link), ["linuxbox#pi"]);
		assert.deepEqual(browser.skipped, [{ id: "mac", label: "mac", kind: "local" }, { id: "linuxbox", label: "linuxbox", kind: "ssh" }]);
		assert.match(DURABLE_RELEASE, /install release\/durable with the same AMPI_HOME/);
		const removed = await new Promise<any>((resolve) => {
			browser.ws.on("message", (data) => { const frame = JSON.parse(String(data)); if (frame.t === "res" && frame.id === 7) resolve(frame); });
			browser.ws.send(JSON.stringify({ t: "hub", id: 7, op: "hosts.remove", args: { id: "linuxbox#pi" } }));
		});
		assert.equal(removed.ok, true, JSON.stringify(removed));
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hosts.map((h: any) => h.kind), ["local", "ssh"], "the skipped rows stay for the durable release");
		assert.deepEqual(hub.hostStates(), []);
		browser.ws.close();
	} finally {
		await hub.close();
		home.release();
	}
});

test("web host routing: findHost takes a link key or a Host ID, a durable thread ID resolves to no Host, and a label falls back to the Host ID", () => {
	type HostState = HubHostState & { link: string };
	const host = (id: string, kind: HostState["kind"], link: string) => ({ id, label: id, kind, status: "connected", link }) as HostState;
	const hosts = [host("mac", "pi-local", "mac#pi"), host("linuxbox", "pi-ssh", "linuxbox#pi")];
	assert.equal(findHost(hosts, "linuxbox")?.link, "linuxbox#pi");
	assert.equal(findHost(hosts, "mac#pi")?.kind, "pi-local");
	assert.equal(findHost(hosts, "mac", "pi:s1")?.link, "mac#pi");
	assert.equal(findHost(hosts, "mac", "t-1"), undefined, "a durable thread has no source here");
	assert.equal(hostLabelFor("mac#pi", hosts), "mac");
	assert.equal(hostLabelFor("gone#pi", hosts), "gone");
});
