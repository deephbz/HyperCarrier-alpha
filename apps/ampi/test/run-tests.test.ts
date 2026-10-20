import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "./bound.ts";

const runner = join(import.meta.dirname, "..", "scripts", "run-tests.cjs");

// At load 232 Node startup plus the 2.5 s slow test passed a 4 s file bound; 10 s leaves the margin.
// A ci-builder probe run hung for 3 h: `--test-timeout` fails the test body, but an open handle keeps the file alive.
test("test runner: a file that never ends fails within its timeout, and the runner exits naming it", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-run-tests-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = (name: string, body: string) => { writeFileSync(join(dir, name), `import { test } from "node:test";\n${body}\n`); return join(dir, name); };
	const files = [
		file("body.test.ts", 'test("never ends", () => new Promise(() => { setInterval(() => {}, 1000); }));'),
		file("handle.test.ts", 'test("passes but leaves a handle", () => { setInterval(() => {}, 1000); });'),
		file("slow.test.ts", 'test("outlives its bound", () => new Promise((done) => setTimeout(done, 2500)));'),
		file("ok.test.ts", 'test("passes", () => {});'),
	];
	const started = Date.now();
	const run = spawnSync(process.execPath, [runner, ...files], {
		encoding: "utf8", timeout: 60_000,
		env: { ...process.env, HOME: dir, AMPI_PREFLIGHT_DONE: "1", AMPI_TEST_TIMEOUT_MS: "1000", AMPI_TEST_FILE_TIMEOUT_MS: "10000" },
	});
	const out = run.stdout + run.stderr, elapsed = Date.now() - started;
	assert.equal(run.signal, null, `runner hung ${elapsed} ms:\n${out}`);
	assert.equal(run.status, 1, out);
	assert.ok(elapsed < 40_000, `runner took ${elapsed} ms`);
	assert.match(out, /✖ never ends/, out);
	for (const name of ["body.test.ts", "handle.test.ts"]) assert.match(out, new RegExp(`TIMEOUT \\S*${name.replace(".", "\\.")}: still running after 10 s`), out);
	// A test over its bound in a file that still exits is a test timeout, reported apart from other failures.
	assert.match(out, /failed files: .*slow\.test\.ts \(1 test timeout at load \d+\/\d+\/\d+\)/, out);
	assert.match(out, /files 4 · timed out 2 · tests 2 · pass 1 · fail 0 · cancelled 1 · skipped 0 · todo 0 · test timeouts [12] /, out);
	assert.doesNotMatch(out, /TIMEOUT ok\.test\.ts/, out);
});

// A bare `node --test --test-name-pattern=… <file>` run bypasses the runner; one hung for 68 min.
test("test bound: a bare node --test run of a file that never ends exits within the file bound and names it", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-bound-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "hang.test.ts");
	writeFileSync(file, `import { test } from "node:test";\nimport ${JSON.stringify(join(import.meta.dirname, "bound.ts"))};\ntest("slash commands never end", () => new Promise(() => { setInterval(() => {}, 1000); }));\n`);
	// Inside a test, node:test's context makes a nested `node --test` skip its files.
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	const started = Date.now();
	const run = spawnSync(process.execPath, ["--test", "--test-name-pattern=slash commands", file], {
		encoding: "utf8", timeout: 60_000, env: { ...env, AMPI_TEST_FILE_TIMEOUT_MS: "3000" },
	});
	const out = run.stdout + run.stderr, elapsed = Date.now() - started;
	assert.equal(run.signal, null, `bare run hung ${elapsed} ms:\n${out}`);
	assert.notEqual(run.status, 0, out);
	assert.ok(elapsed < 30_000, `bare run took ${elapsed} ms`);
	assert.match(out, /TIMEOUT \S*hang\.test\.ts: still running after 3 s\. .*Open: .*Timeout/, out);
});
