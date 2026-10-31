import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyImmutable } from "@earendil-works/chord/delta";
import { PiHost } from "../src/pi/host.ts";
import { WorkingSet } from "../src/pi/working-set.ts";
import { INDEXING } from "../src/shared/protocol.ts";
import { activeSpend } from "../web/src/views/cos/totals.ts";

// After an upgrade changes DERIVATION_VERSION, every saved head is another build's and reads as missing
// (WorkingSet.load). The hub must still list each Session at once, by identity only, and re-derive it newest first.
// This file sets AMPI_FAULT before its first WorkingSet, because the derive Worker copies the environment at creation.

// Inside the recent window (96 hours), so no row needs a live pane to list.
const N = 50, BASE = Date.now() - 3_600_000;
const at = (i: number) => BASE - i * 60_000;
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
/** `cost`: one priced assistant reply before the last message. `older`: a last entry stamped at `started`. */
type Seed = { id: string; cwd: string; started: number; last: number; mtime?: number; cost?: number; older?: boolean };

/** A Pi Session file: header, a user-set name, a first message at `started` and a last one at `last`. */
function writeSession(dir: string, i: number, seed: Seed): string {
	const file = join(dir, `s${i}.jsonl`), iso = (t: number) => new Date(t).toISOString();
	const message = (k: string, parentId: string, t: number) => ({ type: "message", id: k, parentId, timestamp: iso(t), message: { role: "user", content: [{ type: "text", text: `relist needle ${i}` }], timestamp: t } });
	const reply = (cost: number) => ({ type: "message", id: `a${i}`, parentId: `u${i}`, timestamp: iso(seed.last - 1000), message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }], provider: "synthetic", model: "synthetic-model", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: cost } }, stopReason: "stop", timestamp: seed.last - 1000 } });
	writeFileSync(file, [
		{ type: "session", version: 3, id: seed.id, timestamp: iso(seed.started), cwd: seed.cwd },
		{ type: "session_info", id: `n${i}`, parentId: null, timestamp: iso(seed.started), name: `Named ${i}` },
		message(`u${i}`, `n${i}`, seed.started),
		...(seed.cost !== undefined ? [reply(seed.cost)] : []),
		message(`v${i}`, seed.cost !== undefined ? `a${i}` : `u${i}`, seed.last),
		// The derivation takes the latest timestamp of any entry, not the last entry's.
		...(seed.older ? [{ type: "custom", customType: "relist-fixture", id: `o${i}`, parentId: `v${i}`, timestamp: iso(seed.started) }] : []),
	].map((line) => JSON.stringify(line) + "\n").join(""));
	if (seed.mtime !== undefined) utimesSync(file, new Date(seed.mtime), new Date(seed.mtime));
	return file;
}

/** A Host cache with a current head for each seed, and the threads list that the Host serves from those heads. */
async function seeded(t: { after(fn: () => unknown): void }, seeds: Seed[]) {
	const dir = mkdtempSync(join(tmpdir(), "ampi-relist-"));
	const config = { id: "fixture", label: "fixture", kind: "pi-local" as const, remoteNode: "/usr/bin/false", cacheDir: join(dir, "cache") };
	const hosts: PiHost[] = [];
	t.after(async () => { for (const host of hosts) await host.stop(); delete process.env.AMPI_FAULT; rmSync(dir, { recursive: true, force: true }); });
	// The Host keeps its copies in a directory under config.cacheDir.
	const cacheDir = new PiHost(config).cacheDir;
	mkdirSync(cacheDir, { recursive: true });
	const index: Record<string, unknown> = {};
	const store = new WorkingSet(config.id, cacheDir);
	for (const [i, seed] of seeds.entries()) {
		const file = writeSession(cacheDir, i, seed), path = `/synthetic/src/s${i}.jsonl`;
		await store.refresh({ host: config.id, cacheDir, path, file });
		index[path] = { file: `s${i}.jsonl`, offset: 0 };
	}
	store.close();
	writeFileSync(join(cacheDir, "index.json"), JSON.stringify(index));
	const start = (sid: number) => {
		const host = new PiHost(config), frames: any[] = [];
		hosts.push(host); host.on("frame", (f) => frames.push(f));
		host.start(); host.send({ t: "sub", sid, topic: { kind: "threads" } });
		return { host, frames };
	};
	const current = start(1);
	const before = await until(current.frames, 1, (v) => !v.indexing && !v.updating && Object.keys(v.threads).length === seeds.length);
	await current.host.stop();
	return { cacheDir, before, start };
}

/** Rewrites every head as another build's, with sentinel derived values that no list may show. */
function bump(cacheDir: string): void {
	const db = new DatabaseSync(join(cacheDir, "working-set.sqlite"));
	db.exec(`UPDATE sessions SET data=json_set(data, '$.version', '5:old', '$.session.title', 'STALE-TITLE', '$.cost', 999,
		'$.preview', 'STALE-PREVIEW', '$.model', 'stale-model', '$.contextTokens', 77777)`);
	db.close();
}

/** Folds one subscription's frames; resolves with the first value that satisfies `done`. */
async function until(frames: any[], sid: number, done: (value: any) => boolean, ms = 60_000): Promise<any> {
	const end = Date.now() + ms;
	for (;;) {
		let value: any;
		for (const f of frames.filter((f) => f.sid === sid)) {
			if (f.t === "snap") value = f.value; else if (f.t === "ops") value = applyImmutable(value, f.ops);
			else if (f.t === "end") throw new Error(`subscription ended: ${f.reason}`);
			if (value !== undefined && done(value)) return value;
		}
		if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(value)?.slice(0, 400)}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

let nextReq = 0;
function request(host: PiHost, op: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: any; error?: { code?: string; message: string } }> {
	const reqId = `r${++nextReq}`;
	return new Promise((resolve) => {
		const onFrame = (f: any) => { if (f.t === "res" && f.id === reqId) { host.off("frame", onFrame); resolve(f); } };
		host.on("frame", onFrame);
		host.send({ t: "req", id: reqId, op, args } as any);
	});
}

const order = (threads: Record<string, any>) => Object.values(threads).sort((a, b) => b.updatedAt - a.updatedAt).map((t) => t.id);
/** The identity fields of each row; they must not change when a re-derive lands. */
const identities = (threads: Record<string, any>) => Object.fromEntries(Object.values(threads).map((t) => [t.id, [t.ref, t.cwd, t.createdAt, t.updatedAt]]));

test("upgrade: every Session lists at once by identity, re-derives newest first or when opened, then shows its own fields", async (t) => {
	// The copies' mtimes run in write order, the reverse of their activity, so only the Source entries give this order.
	const { cacheDir, before, start } = await seeded(t, Array.from({ length: N }, (_, i) => ({ id: id(i), cwd: `/synthetic/proj${i}`, started: at(i) - 30_000, last: at(i), older: i % 2 === 1 })));
	assert.equal(before.threads[`pi:${id(0)}`].title, "Named 0", "a current head lists the user-set name");
	bump(cacheDir);
	process.env.AMPI_FAULT = "derive-delay:150";
	const { host, frames } = start(2);
	const first = await until(frames, 2, (v) => Object.keys(v.threads).length > 0, 10_000);

	// (a) The same Sessions in the same order, before any derive commits.
	assert.equal(Object.keys(first.threads).length, N);
	assert.deepEqual(order(first.threads), order(before.threads));
	assert.deepEqual(identities(first.threads), identities(before.threads), "the Source identity equals the derived one");
	assert.ok(Object.values(first.threads).every((row: any) => row.updating === true));
	// (b) Identity only: no derived field of the stale head.
	assert.doesNotMatch(JSON.stringify(first), /STALE|stale-model/);
	assert.ok(Object.values(first.threads).every((row: any) => row.costUsd === 0 && row.contextTokens === undefined));
	const row = first.threads[`pi:${id(3)}`];
	assert.equal(row.title, `proj3 · ${id(3).slice(-8)}`);
	assert.equal(row.cwd, "/synthetic/proj3");
	assert.equal(row.ref, `fixture/pi:${id(3)}`);
	assert.equal(row.createdAt, at(3) - 30_000);
	assert.equal(row.updatedAt, at(3));
	for (const key of ["preview", "model", "contextTokens", "cacheHit", "contextWindow"]) assert.equal(row[key], undefined, key);
	assert.equal(row.costUsd, 0);
	assert.deepEqual(host.state.upgrade, { updated: 0, total: N });

	// (d) Opening the 40th-newest Session moves it ahead of the cold backlog.
	const opened = `pi:${id(39)}`;
	host.send({ t: "sub", sid: 3, topic: { kind: "thread", threadId: opened } });
	const updatingView = await until(frames, 3, () => true, 10_000);

	// (c) Its indexed reads refuse with `indexing` until its derive commits; the view says it is updating.
	assert.equal(updatingView.updating, true);
	assert.deepEqual(updatingView.entries, []);
	assert.deepEqual(updatingView.usage, {});
	const refused = await request(host, "thread.history", { threadId: opened });
	assert.equal(refused.ok, false, "thread.history served before the re-derive");
	assert.equal(refused.error?.code, INDEXING);

	// (e) Fleet search names the Sessions still updating.
	const search = await request(host, "sessions.search", { query: "relist needle" });
	assert.equal(search.ok, true);
	assert.equal(search.value.coverage.notIndexed, 0);
	assert.ok(search.value.coverage.updating > 0, "search coverage counts the updating Sessions");
	assert.equal(search.value.coverage.indexed + search.value.coverage.updating, N);

	const derived = await until(frames, 3, (v) => !v.updating && v.entries.length > 0);
	assert.equal(derived.usage.costUsd, 0);
	const settled = host.state.upgrade?.updated ?? N;
	assert.ok(settled < 10, `the opened Session re-derived after ${settled} of ${N} Sessions; the cold backlog reaches it 40th`);
	const history = await request(host, "thread.history", { threadId: opened });
	assert.equal(history.ok, true, JSON.stringify(history.error));
	assert.ok(history.value.entries.length > 0);

	// (f) After the backlog drains: no updating mark, the Session's own fields, and no Host progress.
	const after = await until(frames, 2, (v) => Object.values(v.threads).every((row: any) => !row.updating));
	assert.deepEqual(order(after.threads), order(before.threads));
	assert.deepEqual(identities(after.threads), identities(first.threads), "no row moves when its re-derive lands");
	assert.equal(after.threads[`pi:${id(3)}`].title, "Named 3");
	assert.doesNotMatch(JSON.stringify(after), /STALE|stale-model/);
	const end = Date.now() + 5000;
	while (host.state.upgrade && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
	assert.equal(host.state.upgrade, undefined);
});

test("upgrade: Sessions in one folder, started minutes apart, keep distinct rows from their Source", async (t) => {
	// Pi ids are UUIDv7: Sessions started close together share the first 8 characters.
	const now = Date.now(), cwd = "/synthetic/shared/project";
	const seeds = ["5e55a000-0000-0000-0000-00000000a001", "5e55a000-0001-0000-0000-00000000b002", "5e55a001-0000-0000-0000-00000000c003"]
		.map((uuid, i) => ({ id: uuid, cwd, started: now - 600_000 + i * 240_000, last: now - 300_000 + i * 120_000, mtime: now }));
	const { cacheDir, before, start } = await seeded(t, seeds);
	bump(cacheDir);
	process.env.AMPI_FAULT = "derive-delay:2000";
	const { frames } = start(2);
	const first = await until(frames, 2, (v) => Object.keys(v.threads).length === seeds.length, 10_000);
	const rows = seeds.map((seed) => first.threads[`pi:${seed.id}`]);
	assert.ok(rows.every((row) => row.updating === true));
	assert.deepEqual(rows.map((row) => row.title), seeds.map((seed) => `project · ${seed.id.slice(-8)}`));
	assert.equal(new Set(rows.map((row) => row.title)).size, seeds.length);
	assert.ok(rows.every((row) => !row.title.includes("/")), "a title never shows the raw path");
	assert.deepEqual(rows.map((row) => [row.cwd, row.createdAt, row.updatedAt]), seeds.map((seed) => [cwd, seed.started, seed.last]));
	assert.deepEqual(order(first.threads), order(before.threads));
});

test("upgrade: Overview's spend today reads as partial while any Session updates, and an open Session refills in place", async (t) => {
	const now = Date.now(), costs = [0.5, 0.25, 1, 0.125, 2];
	const seeds = costs.map((cost, i) => ({ id: id(100 + i), cwd: `/synthetic/spend${i}`, started: now - 7_200_000 + i * 60_000, last: now - 600_000 + i * 60_000, cost }));
	const { cacheDir, before, start } = await seeded(t, seeds);
	const today = (threads: Record<string, any>) => activeSpend(Object.values(threads), now - 86_400_000);
	const complete = today(before.threads);
	assert.deepEqual(complete, { label: "$3.88 (excludes compaction, tool model calls)", updating: 0 });
	bump(cacheDir);
	// A copy whose first line is not a Pi header lists no row, but the progress counts it until its derive settles.
	writeFileSync(join(cacheDir, "junk.jsonl"), "not a Pi header\n");
	const index = JSON.parse(readFileSync(join(cacheDir, "index.json"), "utf8"));
	writeFileSync(join(cacheDir, "index.json"), JSON.stringify({ ...index, "/synthetic/src/junk.jsonl": { file: "junk.jsonl", offset: 0 } }));
	process.env.AMPI_FAULT = "derive-delay:3000";
	const { host, frames } = start(2);
	const first = await until(frames, 2, (v) => Object.keys(v.threads).length === seeds.length, 10_000);
	assert.deepEqual(host.state.upgrade, { updated: 0, total: seeds.length + 1 });
	assert.deepEqual(today(first.threads), { label: `≥ $0 · ${seeds.length} updating`, updating: seeds.length });

	// An open updating Session refills on the same subscription when its derive commits.
	const opened = `pi:${id(102)}`;
	host.send({ t: "sub", sid: 3, topic: { kind: "thread", threadId: opened } });
	assert.equal((await until(frames, 3, () => true, 10_000)).updating, true);
	const refilled = await until(frames, 3, (v) => !v.updating && v.entries.length > 0, 30_000);
	assert.ok(refilled.entries.length >= 3, `the opened Session refilled with ${refilled.entries.length} entries`);

	// Every list value while a Session updates names the total as partial.
	const after = await until(frames, 2, (v) => {
		const spend = today(v.threads);
		if (spend.updating) assert.match(spend.label, /^≥ \$[\d.]+( \(excludes compaction, tool model calls\))? · [1-5] updating$/, JSON.stringify(spend));
		return spend.updating === 0;
	});
	assert.deepEqual(today(after.threads), complete);
	const end = Date.now() + 10_000;
	while (host.state.upgrade && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
	assert.equal(host.state.upgrade, undefined, "the progress ends once the copy without a header settles");
});
