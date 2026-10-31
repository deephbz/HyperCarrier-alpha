import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-ignore: the perf scripts are plain ESM.
import { parseTrace } from "../scripts/perf/report.mjs";

const traceModule = new URL("../src/trace.ts", import.meta.url).href;

/** Runs a child process that uses trace.ts, with or without AMPI_TRACE. */
function child(dir: string | undefined, body: string, cwd?: string) {
	const env = { ...process.env };
	delete env.AMPI_TRACE;
	if (dir) env.AMPI_TRACE = dir;
	const script = `import * as t from ${JSON.stringify(traceModule)};\nimport { DatabaseSync } from "node:sqlite";\n${body}`;
	return execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, cwd, encoding: "utf8" });
}

test("trace: a traced process writes one file per thread with spans, SQLite statements and runtime counters", () => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-trace-"));
	try {
		child(dir, `
t.nameProcess("hub");
t.instant("listen", { port: 1 });
t.span("outer", "startup", () => t.span("inner", "startup", () => 0));
await t.spanAsync("load", "startup", async () => 0);
const db = t.traceDb(new DatabaseSync(":memory:"), "read");
db.exec("CREATE TABLE x (a INTEGER)");
const insert = db.prepare("INSERT INTO x (a)\\n VALUES (?)");
insert.run(1); insert.run(2);
db.prepare("SELECT a FROM x").all();
for (const _ of db.prepare("SELECT a FROM x WHERE a > ?").iterate(0));
await new Promise((r) => setTimeout(r, 300));
`);
		const files = readdirSync(dir);
		assert.equal(files.length, 1);
		assert.match(files[0], /^trace-\d+-0\.json$/);
		const text = readFileSync(join(dir, files[0]), "utf8");
		assert.ok(text.endsWith("\n"), "each flush ends with a whole line");
		const events = parseTrace(text);
		const named = (name: string) => events.filter((e: { name: string }) => e.name === name);
		assert.equal(named("process_name")[0].args.name, "hub");
		assert.equal(named("thread_name")[0].args.name, "main");
		assert.equal(named("listen")[0].ph, "i");
		const [outer] = named("outer"), [inner] = named("inner");
		assert.ok(inner.ts >= outer.ts && inner.ts + inner.dur <= outer.ts + outer.dur, "nested spans nest in time");
		assert.deepEqual(named("load").map((e: { ph: string }) => e.ph), ["b", "e"]);
		const inserts = named("INSERT INTO x (a) VALUES (?)");
		assert.equal(inserts.length, 2, "statement names are whitespace-collapsed SQL with no bound values");
		assert.deepEqual(inserts[0].args, { db: "read", op: "run", changes: 1 });
		assert.equal(named("SELECT a FROM x")[0].args.rows, 2);
		const iterated = named("SELECT a FROM x WHERE a > ?")[0];
		assert.equal(iterated.ph, "i");
		assert.equal(iterated.args.rows, 2);
		assert.equal(named("CREATE TABLE x (a INTEGER)")[0].args.op, "exec");
		assert.equal(named("clock-sync")[0].ph, "X");
		assert.ok(named("event-loop-delay-ms").length >= 1);
		assert.ok(named("memory-mb").some((e: { args: { rss?: number } }) => e.args.rss! > 0));
		// Shared clock: Unix epoch µs.
		assert.ok(Math.abs(named("listen")[0].ts / 1000 - Date.now()) < 60_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("trace: a traced cursor that ends early reads what a raw cursor reads: break and throw release the snapshot", () => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-trace-cursor-"));
	try {
		const out = child(join(dir, "trace"), `
const file = ${JSON.stringify(join(dir, "db.sqlite"))};
const write = new DatabaseSync(file);
write.exec("PRAGMA journal_mode=WAL; CREATE TABLE k (v INTEGER); INSERT INTO k VALUES (0); CREATE TABLE x (a INTEGER)");
for (let a = 1; a <= 50; a++) write.prepare("INSERT INTO x VALUES (?)").run(a);
const readers = { raw: new DatabaseSync(file), traced: t.traceDb(new DatabaseSync(file), "read") };
const head = (read) => { read.exec("BEGIN"); try { return read.prepare("SELECT v FROM k").get().v; } finally { read.exec("ROLLBACK"); } };
const seen = [], held = [];
// The ways a consumer leaves a cursor: break, a throw from the loop body, and abandon after one row (no return()).
const exits = {
	break: (read) => { for (const row of read.prepare("SELECT a FROM x").iterate()) if (row.a >= 3) break; },
	throw: (read) => { try { for (const row of read.prepare("SELECT a FROM x").iterate()) if (row.a >= 3) throw new Error("stop"); } catch {} },
	abandon: (read) => { const rows = read.prepare("SELECT a FROM x").iterate(); rows.next(); held.push(rows); },
};
for (const [exit, leave] of Object.entries(exits)) for (const [reader, read] of Object.entries(readers)) {
	read.exec("BEGIN"); leave(read); read.exec("ROLLBACK");
	write.prepare("UPDATE k SET v = v + 1").run();
	seen.push({ exit, reader, fresh: head(read) === write.prepare("SELECT v FROM k").get().v });
}
for (const rows of held) rows.return();
const rows = readers.traced.prepare("SELECT a FROM x").iterate();
console.log(JSON.stringify({ seen, helpers: typeof rows.toArray, all: rows.toArray().length }));
t.flushTrace();
`);
		const { seen, helpers, all } = JSON.parse(out);
		const fresh = (exit: string, reader: string) => seen.find((s: { exit: string; reader: string }) => s.exit === exit && s.reader === reader).fresh;
		for (const exit of ["break", "throw", "abandon"]) assert.equal(fresh(exit, "traced"), fresh(exit, "raw"), `after ${exit}, tracing does not change what the next snapshot reads`);
		assert.ok(fresh("break", "traced") && fresh("throw", "traced"), "after break or throw, the next snapshot reads the committed head");
		assert.equal(fresh("abandon", "raw"), false, "an abandoned cursor pins its snapshot until GC, raw or traced: the working set repairs that class");
		assert.equal(helpers, "function", "a traced cursor keeps the native Iterator helpers");
		assert.equal(all, 50);
		const [file] = readdirSync(join(dir, "trace"));
		const iterated = parseTrace(readFileSync(join(dir, "trace", file), "utf8")).filter((e: { name: string }) => e.name === "SELECT a FROM x");
		assert.deepEqual(iterated.map((e: { args: { rows: number } }) => e.args.rows), [3, 3, 1, 50], "each cursor records one span with the rows it read, when it ends");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("trace: without AMPI_TRACE nothing is written and the API is a no-op", () => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-trace-off-"));
	try {
		const out = child(undefined, `
const db = new DatabaseSync(":memory:");
console.log(JSON.stringify({ tracing: t.tracing, same: t.traceDb(db, "read") === db, value: t.span("x", "startup", () => 7) }));
t.flushTrace();
`, dir);
		assert.deepEqual(JSON.parse(out), { tracing: false, same: true, value: 7 });
		assert.deepEqual(readdirSync(dir), [], "no trace file appears, even in the working directory");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loop watch: each event-loop block over 250 ms gets one line that names the watched sections in it", async () => {
	const { LoopWatch } = await import("../src/loop-watch.ts");
	// A fake clock: `spin` is synchronous work, `tick` a 50 ms timer tick that comes `late` ms late.
	let now = 0;
	const lines: string[] = [];
	const watch = new LoopWatch(() => now, (line) => lines.push(line));
	const spin = (ms: number) => void (now += ms);
	const tick = (late = 0) => { spin(50 + late); watch.tick(); };
	tick();
	watch.watched(() => "agent frame agents on devbox", () => { spin(300); watch.watched(() => "topic threads", () => spin(100)); });
	tick();
	spin(320);
	tick();
	for (let i = 0; i < 30; i++) watch.watched(() => "short", () => spin(10));
	tick();
	watch.watched(() => "short", () => spin(5));
	tick(200);
	assert.deepEqual(lines, [
		"event loop: blocked 400 ms; ran: agent frame agents on devbox 400 ms, topic threads 100 ms",
		"event loop: blocked 320 ms; ran: no single section over 20 ms",
		"event loop: blocked 300 ms; ran: no single section over 20 ms; 30 short sections, 300 ms",
	]);
	assert.deepEqual([watch.over50, watch.over250], [4, 3]);
});

test("loop watch: a window logs at most 10 block lines and counts the rest", async () => {
	const { LoopWatch } = await import("../src/loop-watch.ts");
	let now = 0;
	const lines: string[] = [];
	const watch = new LoopWatch(() => now, (line) => lines.push(line));
	for (let i = 0; i < 12; i++) { now += 50 + 300; watch.tick(); }
	assert.equal(lines.length, 10);
	assert.equal(watch.suppressed, 2);
	watch.endWindow();
	now += 350;
	watch.tick();
	assert.equal(lines.length, 11);
});

test("loop watch: log times carry the machine's local zone offset", () => {
	const module = new URL("../src/loop-watch.ts", import.meta.url).href;
	const script = `import { localTime } from ${JSON.stringify(module)}; console.log(localTime(new Date("2026-10-19T03:45:00.123Z")));`;
	const at = (TZ: string) => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ } }).trim();
	assert.equal(at("Asia/Singapore"), "2026-10-19T11:45:00.123+08:00");
	assert.equal(at("UTC"), "2026-10-19T03:45:00.123+00:00");
	assert.equal(at("America/St_Johns"), "2026-10-19T01:15:00.123-02:30");
});
