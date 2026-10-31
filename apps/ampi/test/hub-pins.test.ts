import "./bound.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import type { HubHome } from "../src/hub/home.ts";
import { Hub } from "../src/hub/hub.ts";
import { save } from "../src/hub/pins.ts";
import { ownHome as own } from "./helpers.ts";
import type { Pin } from "../src/shared/protocol.ts";

const token = "e".repeat(64);

/** A browser socket that keeps the last `pins` frame and answers hub ops. */
async function open(port: number) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}`, authorization: `Bearer ${token}` } });
	const state = { pins: undefined as Pin[] | undefined, frames: 0 };
	const waiters = new Map<number, (frame: any) => void>();
	ws.on("message", (data) => {
		const frame = JSON.parse(String(data));
		if (frame.t === "pins") { state.pins = frame.pins; state.frames++; }
		if (frame.t === "res") waiters.get(frame.id)?.(frame);
	});
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	let id = 1;
	const hubOp = (op: string, args: unknown) => new Promise<any>((resolve) => { const n = id++; waiters.set(n, resolve); ws.send(JSON.stringify({ t: "hub", id: n, op, args })); });
	const when = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(predicate(), JSON.stringify(state)); };
	return { ws, state, hubOp, when };
}

test("pins: every browser gets the list on connect and after each change, and a restart keeps it", async () => {
	const home = mkdtempSync(join(tmpdir(), "ampi-pins-"));
	const pinsPath = join(home, "pins.json");
	try {
		let hubHome = own(home);
		let hub = new Hub({ hosts: [] }, { token, home: hubHome });
		let port = await hub.listen(0);
		const a = await open(port);
		const b = await open(port);
		await a.when(() => a.state.pins !== undefined);
		assert.deepEqual(a.state.pins, []);

		assert.equal((await a.hubOp("pins.set", { host: "devbox", threadId: "t1", pinned: true, intent: "owner", title: "deploy lead" })).ok, true);
		await b.when(() => b.state.pins?.length === 1);
		assert.deepEqual(b.state.pins!.map((p) => [p.host, p.threadId, p.title]), [["devbox", "t1", "deploy lead"]]);
		await a.hubOp("pins.set", { host: "devbox", threadId: "t2", pinned: true, intent: "owner", title: "perf" });
		// A repeated pin renames in place; unpinning an unknown pin changes nothing.
		await a.hubOp("pins.set", { host: "devbox", threadId: "t1", pinned: true, title: "deploy lead 2" });
		await a.hubOp("pins.set", { host: "devbox", threadId: "nope", pinned: false });
		await b.when(() => b.state.pins?.[0]?.title === "deploy lead 2");
		assert.deepEqual(b.state.pins!.map((p) => p.threadId), ["t1", "t2"]);
		const refused = await a.hubOp("pins.set", { host: "", threadId: "t3", pinned: true, intent: "owner" });
		assert.equal(refused.ok, false);

		a.ws.close(); b.ws.close();
		await hub.close();
		hubHome.release();
		hubHome = own(home);
		hub = new Hub({ hosts: [] }, { token, home: hubHome });
		port = await hub.listen(0);
		const c = await open(port);
		await c.when(() => c.state.pins !== undefined);
		assert.deepEqual(c.state.pins!.map((p) => [p.threadId, p.title]), [["t1", "deploy lead 2"], ["t2", "perf"]]);
		await c.hubOp("pins.set", { host: "devbox", threadId: "t1", pinned: false });
		await c.when(() => c.state.pins?.length === 1);
		assert.deepEqual(JSON.parse(readFileSync(pinsPath, "utf8")).pins.map((p: Pin) => p.threadId), ["t2"]);
		c.ws.close();
		await hub.close();
		hubHome.release();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("pins: an unreadable pins.json moves aside and the hub starts with no pins", async () => {
	const home = mkdtempSync(join(tmpdir(), "ampi-pins-"));
	const pinsPath = join(home, "pins.json");
	writeFileSync(pinsPath, "{ not json");
	const hubHome = own(home);
	try {
		const hub = new Hub({ hosts: [] }, { token, home: hubHome });
		const port = await hub.listen(0);
		const a = await open(port);
		await a.when(() => a.state.pins !== undefined);
		assert.deepEqual(a.state.pins, []);
		assert.ok(readdirSync(home).some((name) => name.startsWith("pins.json.unreadable-")), "the unreadable file is kept");
		await a.hubOp("pins.set", { host: "devbox", threadId: "t1", pinned: true, intent: "owner" });
		await a.when(() => a.state.pins?.length === 1);
		a.ws.close();
		await hub.close();
	} finally {
		hubHome.release();
		rmSync(home, { recursive: true, force: true });
	}
});

/** A fresh home that the test owns, with an optional pins.json written first. */
async function withHome(seed: unknown, fn: (home: HubHome, pinsPath: string) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "ampi-pins-"));
	const pinsPath = join(dir, "pins.json");
	if (seed !== undefined) writeFileSync(pinsPath, typeof seed === "string" ? seed : JSON.stringify(seed));
	const home = own(dir);
	try { await fn(home, pinsPath); } finally { home.release(); chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
}
const stored = (pinsPath: string) => JSON.parse(readFileSync(pinsPath, "utf8"));

test("pins: one pin per threadId; a pin from another Host route keeps the pin, its hint and its place", () => withHome(undefined, async (home, pinsPath) => {
	const hub = new Hub({ hosts: [] }, { token, home });
	const a = await open(await hub.listen(0));
	await a.hubOp("pins.set", { host: "devbox", threadId: "pi:s1", pinned: true, intent: "owner", title: "lead" });
	await a.hubOp("pins.set", { host: "devbox", threadId: "pi:s2", pinned: true, intent: "owner", title: "perf" });
	// The row menu pinned it on one route; the star on another route sees the same Session. The intent is already met.
	assert.equal((await a.hubOp("pins.set", { host: "devbox#pi", threadId: "pi:s1", pinned: true })).ok, true);
	assert.deepEqual(a.state.pins!.map((p) => [p.host, p.threadId, p.title]), [["devbox", "pi:s1", "lead"], ["devbox", "pi:s2", "perf"]]);
	assert.deepEqual(stored(pinsPath), { version: 1, pins: a.state.pins }, "the file holds one key form and no at field");
	// Unpinning on any route, with or without a host, removes the one pin.
	await a.hubOp("pins.set", { threadId: "pi:s1", pinned: false });
	await a.when(() => a.state.pins?.length === 1);
	a.ws.close();
	await hub.close();
}));

test("pins: an older file with one Session under two Host ids loads as one pin: first place, newest hint", () => withHome({ version: 1, pins: [
	{ host: "devbox", threadId: "pi:s1", title: "old title", at: 5 },
	{ host: "devbox", threadId: "pi:s2", title: "two", at: 6 },
	{ host: "devbox#pi", threadId: "pi:s1", title: "", at: 7 },
	{ host: "devbox", threadId: 3, title: "bad" },
] }, async (home) => {
	const hub = new Hub({ hosts: [] }, { token, home });
	const a = await open(await hub.listen(0));
	await a.when(() => a.state.pins !== undefined);
	assert.deepEqual(a.state.pins, [{ host: "devbox#pi", threadId: "pi:s1", title: "old title" }, { host: "devbox", threadId: "pi:s2", title: "two" }]);
	a.ws.close();
	await hub.close();
}));

test("pins: a file of another version stays untouched and pins.set refuses", () => withHome({ version: 2, pins: [{ id: "pi:s1" }] }, async (home, pinsPath) => {
	const before = readFileSync(pinsPath, "utf8");
	const hub = new Hub({ hosts: [] }, { token, home });
	const a = await open(await hub.listen(0));
	await a.when(() => a.state.pins !== undefined);
	const refused = await a.hubOp("pins.set", { host: "devbox", threadId: "pi:s1", pinned: true, intent: "owner" });
	assert.equal(refused.ok, false);
	assert.match(JSON.stringify(refused), /version 2/);
	assert.equal(readFileSync(pinsPath, "utf8"), before);
	a.ws.close();
	await hub.close();
}));

test("pins: an unreadable file that cannot move aside makes this run refuse writes", () => withHome("{ not json", async (home, pinsPath) => {
	chmodSync(home.dir, 0o500);
	const hub = new Hub({ hosts: [] }, { token, home });
	const a = await open(await hub.listen(0));
	await a.when(() => a.state.pins !== undefined);
	chmodSync(home.dir, 0o700);
	const refused = await a.hubOp("pins.set", { host: "devbox", threadId: "pi:s1", pinned: true, intent: "owner" });
	assert.equal(refused.ok, false);
	assert.match(JSON.stringify(refused), /could not be moved aside/);
	assert.equal(readFileSync(pinsPath, "utf8"), "{ not json");
	assert.deepEqual(readdirSync(home.dir).filter((name) => name.startsWith("pins")), ["pins.json"], "no temporary file is left");
	a.ws.close();
	await hub.close();
}));

test("pins: a save whose rename fails leaves no tmp file and keeps what was there", () => {
	const home = mkdtempSync(join(tmpdir(), "ampi-pins-"));
	try {
		// A rename onto a non-empty directory fails after the tmp file is written.
		const pinsPath = join(home, "pins.json");
		mkdirSync(pinsPath);
		writeFileSync(join(pinsPath, "keep"), "x");
		assert.throws(() => save(pinsPath, [{ host: "devbox", threadId: "pi:s1", title: "" }]));
		assert.deepEqual(readdirSync(home), ["pins.json"]);
		assert.deepEqual(readdirSync(pinsPath), ["keep"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("pins: a host hint moves only an existing pin; a late hint after an unpin leaves the Session unpinned", () => withHome(undefined, async (home, pinsPath) => {
	const hub = new Hub({ hosts: [] }, { token, home });
	const a = await open(await hub.listen(0));
	await a.when(() => a.state.pins !== undefined);
	// A hint for a Session that is not pinned creates nothing.
	assert.equal((await a.hubOp("pins.hint", { host: "devbox", threadId: "pi:s1" })).ok, true);
	assert.deepEqual(a.state.pins, []);
	await a.hubOp("pins.set", { host: "old-host", threadId: "pi:s1", pinned: true, intent: "owner", title: "lead" });
	await a.when(() => a.state.pins?.length === 1);
	// Two windows send the same hint: the first moves the hint, keeping the place and title; the second changes nothing.
	const frames = a.state.frames;
	assert.equal((await a.hubOp("pins.hint", { host: "devbox#pi", threadId: "pi:s1" })).ok, true);
	assert.equal((await a.hubOp("pins.hint", { host: "devbox#pi", threadId: "pi:s1" })).ok, true);
	assert.equal(a.state.frames, frames + 1, "two identical hints make one change");
	assert.deepEqual(a.state.pins, [{ host: "devbox#pi", threadId: "pi:s1", title: "lead" }]);
	assert.deepEqual(stored(pinsPath).pins, a.state.pins);
	// The owner unpins; a window that still saw the old list sends its hint late.
	await a.hubOp("pins.set", { host: "devbox#pi", threadId: "pi:s1", pinned: false });
	await a.when(() => a.state.pins?.length === 0);
	assert.equal((await a.hubOp("pins.hint", { host: "devbox", threadId: "pi:s1" })).ok, true);
	assert.deepEqual(a.state.pins, []);
	assert.deepEqual(stored(pinsPath).pins, []);
	a.ws.close();
	await hub.close();
}));

test("pins: only an owner action changes membership; every setPin call in the web app is a click handler", () => {
	const dir = new URL("../web/src/", import.meta.url);
	const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f));
	let calls = 0;
	for (const file of files) {
		const source = readFileSync(new URL(file, dir), "utf8");
		for (const line of source.split("\n")) {
			if (!/\bsetPin\(/.test(line) || /export function setPin\(/.test(line)) continue;
			calls++;
			assert.match(line, /onClick=\{\(\) => \{? ?setPin\(/, `${file}: setPin outside a click handler: ${line.trim()}`);
		}
	}
	assert.ok(calls >= 3, `the star, the menu and the × call setPin (${calls})`);
});

test("pins: an unmarked create from a page older than the hub is refused; an unmarked unpin or repeated pin applies", () => withHome(undefined, async (home, pinsPath) => {
	const hub = new Hub({ hosts: [] }, { token, home });
	const a = await open(await hub.listen(0));
	await a.hubOp("pins.set", { host: "devbox", threadId: "pi:s1", pinned: true, intent: "owner", title: "lead" });
	await a.when(() => a.state.pins?.length === 1);
	// An old page's hint repair is an unmarked pin: on an existing pin it changes nothing.
	assert.equal((await a.hubOp("pins.set", { host: "devbox#pi", threadId: "pi:s1", pinned: true })).ok, true);
	assert.deepEqual(a.state.pins, [{ host: "devbox", threadId: "pi:s1", title: "lead" }]);
	// An old page's star unpins without the marker.
	assert.equal((await a.hubOp("pins.set", { host: "devbox", threadId: "pi:s1", pinned: false })).ok, true);
	assert.deepEqual(a.state.pins, []);
	const before = readFileSync(pinsPath, "utf8");
	// The old page's late hint repair arrives after the unpin.
	const refused = await a.hubOp("pins.set", { host: "devbox#pi", threadId: "pi:s1", pinned: true });
	assert.equal(refused.ok, false);
	assert.match(refused.error?.message ?? "", /This page is older than the hub\. Reload it\./);
	assert.deepEqual(a.state.pins, []);
	assert.equal(readFileSync(pinsPath, "utf8"), before, "a refused create leaves pins.json unchanged");
	// A marked owner click creates the pin.
	assert.equal((await a.hubOp("pins.set", { host: "devbox", threadId: "pi:s1", pinned: true, intent: "owner" })).ok, true);
	assert.deepEqual(a.state.pins, [{ host: "devbox", threadId: "pi:s1", title: "" }]);
	a.ws.close();
	await hub.close();
}));
