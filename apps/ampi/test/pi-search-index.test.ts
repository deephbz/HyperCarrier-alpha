import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillSearch, fleetSearch, forgetSearch, forgetSearchBatch, indexProse, searchSchema } from "../src/pi/search.ts";
import { openWorkingSet, readWorkingSet } from "../src/pi/working-set-db.ts";
import type { PiReaderEntry } from "../src/pi/views/types.ts";

const human = (id: string, text: string) => ({ id, kind: "human", blocks: [{ type: "text", text }] }) as unknown as PiReaderEntry;
function store() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE sessions (path TEXT PRIMARY KEY, data TEXT NOT NULL)");
	searchSchema(db);
	return db;
}
function session(db: DatabaseSync, path: string) {
	db.prepare("INSERT OR REPLACE INTO sessions VALUES (?,?)").run(path, JSON.stringify({ session: { id: path, ref: `ref-${path}`, title: path }, version: "2:v", asOf: 1 }));
}
const fill = (db: DatabaseSync, paths: number, rows: number) => {
	db.exec("BEGIN");
	for (let p = 0; p < paths; p++) for (let r = 0; r < rows; r++) indexProse(db, `s${p}`, human(`e${r}`, `filler ${p} ${r} 你好世界`));
	db.exec("COMMIT");
};
const prose = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM prose").get()!.n);
const ms = (run: () => void) => { const t = performance.now(); run(); return performance.now() - t; };
// Bounds count full FTS scans timed in this process, so machine load scales both sides.
// Each defect cost one scan per Session or per prose_path backfill (7 scans at 100k rows).
const scan = (db: DatabaseSync) => [0, 1, 2].map(() => ms(() => db.prepare("SELECT count(*) FROM prose WHERE path=?").get("\0none"))).sort((a, b) => a - b)[1]!;

test("search index: forgetting one path at 100k prose rows costs that path's rows, not a full FTS scan (cold rebuild stalled at 0.03 Sessions/s)", () => {
	const db = store();
	fill(db, 10_000, 10);
	assert.equal(prose(db), 100_000);
	const full = scan(db), elapsed = ms(() => { for (let p = 0; p < 20; p++) forgetSearch(db, `s${p}`); });
	assert.equal(prose(db), 100_000 - 200);
	assert.ok(elapsed < 5 * full, `20 forgets took ${elapsed.toFixed(0)} ms, ${(elapsed / full).toFixed(1)} full scans`);
	const plan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM prose WHERE rowid IN (SELECT rowid FROM prose_path WHERE path=?)").all("s1").map((r) => String(r.detail));
	assert.ok(plan.some((d) => /prose_path_path/.test(d)), plan.join("\n"));
	assert.ok(!plan.some((d) => /SCAN prose VIRTUAL TABLE INDEX 0:$/.test(d)), plan.join("\n"));
});

test("search index: forgetting a never-indexed path changes nothing and does not scan prose", () => {
	const db = store();
	fill(db, 10_000, 10);
	const full = scan(db), elapsed = ms(() => { for (let p = 0; p < 200; p++) forgetSearch(db, `new${p}`); });
	assert.equal(prose(db), 100_000);
	assert.ok(elapsed < full, `200 cold forgets took ${elapsed.toFixed(0)} ms, ${(elapsed / full).toFixed(1)} full scans`);
});

test("search index: delete and re-index keeps fleet results identical, including CJK bigrams", () => {
	const db = store();
	for (const path of ["a", "b"]) { session(db, path); indexProse(db, path, human("e0", `alpha ${path} 你好`)); indexProse(db, path, human("e1", `beta ${path}`)); }
	const before = [fleetSearch(db, "alpha"), fleetSearch(db, "你好"), fleetSearch(db, "beta")];
	forgetSearch(db, "a");
	assert.deepEqual(fleetSearch(db, "alpha").hits.map((h) => h.threadId), ["b"]);
	indexProse(db, "a", human("e0", "alpha a 你好")); indexProse(db, "a", human("e1", "beta a"));
	const sorted = (r: ReturnType<typeof fleetSearch>) => r.hits.map((h) => `${h.threadId}#${h.entry}:${h.snippet}`).sort();
	assert.deepEqual([fleetSearch(db, "alpha"), fleetSearch(db, "你好"), fleetSearch(db, "beta")].map(sorted), before.map(sorted));
	assert.equal(Number(db.prepare("SELECT count(*) AS n FROM prose_path").get()!.n), prose(db));
});

test("search index: opening a 100k-row cache written before prose_path does not backfill on the opener's thread (a 598k-row backfill blocked startup for 60 s)", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE sessions (path TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE VIRTUAL TABLE prose USING fts5(path UNINDEXED, id UNINDEXED, text, cjk, tokenize='unicode61');");
	db.exec("BEGIN");
	for (let i = 0; i < 100_000; i++) db.prepare("INSERT INTO prose(path,id,text,cjk) VALUES (?,?,?,?)").run(`old${i % 1000}`, `e${i}`, `legacy filler ${i}`, "");
	db.exec("COMMIT");
	const full = scan(db), open = ms(() => searchSchema(db));
	assert.ok(open < 2 * full, `opening took ${(open / full).toFixed(1)} full scans`);
	assert.equal(Number(db.prepare("SELECT count(*) AS n FROM prose_path").get()!.n), 0);
	const step = ms(() => backfillSearch(db, 2000));
	assert.ok(step < 2 * full, `one step took ${(step / full).toFixed(1)} full scans`);
	assert.equal(Number(db.prepare("SELECT count(*) AS n FROM prose_path").get()!.n), 2000);
});

test("search index: an old cache forgets correctly before, during and after the bounded Worker backfill, one-shot and batched", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE sessions (path TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE VIRTUAL TABLE prose USING fts5(path UNINDEXED, id UNINDEXED, text, cjk, tokenize='unicode61');");
	const paths = ["a", "b", "c", "d", "kept"];
	for (const path of paths) { session(db, path); for (let i = 0; i < 3; i++) db.prepare("INSERT INTO prose(path,id,text,cjk) VALUES (?,?,?,?)").run(path, `e${i}`, `legacy ${path}`, ""); }
	searchSchema(db);
	searchSchema(db);
	forgetSearch(db, "a");
	assert.equal(backfillSearch(db, 4), false);
	forgetSearch(db, "b");
	indexProse(db, "b", human("e9", "legacy b again"));
	while (forgetSearchBatch(db, "d", 2));
	let steps = 1;
	while (!backfillSearch(db, 4)) steps++;
	assert.ok(steps >= 2, `${steps} steps`);
	assert.equal(Number(db.prepare("SELECT count(*) AS n FROM prose_path").get()!.n), prose(db));
	forgetSearch(db, "c");
	assert.deepEqual(fleetSearch(db, "legacy").hits.map((h) => `${h.threadId}#${h.entry}`).sort(), ["b#e9", "kept#e0", "kept#e1", "kept#e2"]);
	assert.equal(backfillSearch(db), true);
});

const orphans = (db: DatabaseSync) => Number(db.prepare("SELECT (SELECT count(*) FROM prose_path WHERE rowid NOT IN (SELECT rowid FROM prose)) + (SELECT count(*) FROM prose WHERE rowid NOT IN (SELECT rowid FROM prose_path)) AS n").get()!.n);

test("search index: batch forget removes the same rows from prose and prose_path through the path index", () => {
	const db = store();
	fill(db, 1_000, 10);
	const batches: number[] = [];
	for (let n = 1; n;) { db.exec("BEGIN"); n = forgetSearchBatch(db, "s7", 3); db.exec("COMMIT"); batches.push(n); }
	assert.deepEqual(batches, [3, 3, 3, 1, 0]);
	assert.equal(prose(db), 10_000 - 10);
	assert.equal(Number(db.prepare("SELECT count(*) AS n FROM prose_path WHERE path='s7'").get()!.n), 0);
	assert.equal(Number(db.prepare("SELECT count(*) AS n FROM prose WHERE path='s7'").get()!.n), 0);
	assert.equal(orphans(db), 0);
	const batch = "SELECT rowid FROM prose_path WHERE path=? ORDER BY rowid LIMIT ?";
	for (const sql of [`DELETE FROM prose WHERE rowid IN (${batch})`, `DELETE FROM prose_path WHERE rowid IN (${batch})`]) {
		const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("s1", 3).map((r) => String(r.detail));
		assert.ok(plan.some((d) => /^SEARCH prose_path USING COVERING INDEX prose_path_path/.test(d)), plan.join("\n"));
		assert.ok(!plan.some((d) => /^SCAN prose_path|SCAN prose VIRTUAL TABLE INDEX 0:$/.test(d)), plan.join("\n"));
	}
	// The plans above prove the index path; a 10k-row timing only measures load.
	for (let p = 100; p < 120; p++) while (forgetSearchBatch(db, `s${p}`, 4));
	assert.equal(orphans(db), 0);
});

test("search index: the hub's read-only connection never creates or backfills prose_path; the Worker writer does", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-search-readonly-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const legacy = new DatabaseSync(join(dir, "working-set.sqlite"));
	legacy.exec("PRAGMA journal_mode=DELETE; CREATE TABLE sessions (path TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE VIRTUAL TABLE prose USING fts5(path UNINDEXED, id UNINDEXED, text, cjk, tokenize='unicode61');");
	session(legacy, "old");
	legacy.prepare("INSERT INTO prose(path,id,text,cjk) VALUES (?,?,?,?)").run("old", "e0", "legacy old", "");
	legacy.close();
	const bytes = readFileSync(join(dir, "working-set.sqlite"));
	const reader = readWorkingSet(dir);
	assert.deepEqual(fleetSearch(reader, "legacy").hits.map((h) => h.threadId), ["old"]);
	assert.throws(() => searchSchema(reader), /readonly|read-only|query_only/i);
	assert.equal(reader.prepare("SELECT 1 FROM sqlite_master WHERE name='prose_path'").get(), undefined);
	reader.close();
	assert.ok(readFileSync(join(dir, "working-set.sqlite")).equals(bytes), "read-only open changed the cache file");
	const writer = openWorkingSet(dir);
	while (!backfillSearch(writer));
	assert.equal(Number(writer.prepare("SELECT count(*) AS n FROM prose_path").get()!.n), 1);
	writer.exec("BEGIN"); assert.equal(forgetSearchBatch(writer, "old", 8), 1); writer.exec("COMMIT");
	assert.equal(prose(writer), 0);
	writer.close();
});
