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
