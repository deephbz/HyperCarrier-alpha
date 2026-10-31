import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import "./bound.ts";

const runner = join(import.meta.dirname, "..", "scripts", "run-tests.cjs");
const scripts = join(import.meta.dirname, "..", "scripts");

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

// Bun caches os.homedir() at start (2026-10-29: a Bun run wrote the operator's ~/.pi). A worker thread is the same case
// under Node: its HOME stays in its own process.env copy and never reaches os.homedir().
test("test isolation: a process whose os.homedir() does not follow the fresh HOME stops before any test code runs", async () => {
	const worker = new Worker(new URL("./isolate.ts", import.meta.url));
	const error = await new Promise<unknown>((resolve) => { worker.once("error", resolve); worker.once("exit", () => resolve(undefined)); });
	assert.match(String(error), /HOME isolation failed: os\.homedir\(\) is .* No test code ran\./);
});

// A caller's provider key signed a test in (2026-10-31: ANTHROPIC_API_KEY on an Amp orb failed accounts.test).
test("test isolation: a test process and its children see no provider credential that the caller set", () => {
	const caller = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "FUTURECO_API_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE", "AZURE_OPENAI_BASE_URL", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "HF_TOKEN", "COPILOT_GITHUB_TOKEN"];
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	const run = spawnSync(process.execPath, ["--import", join(import.meta.dirname, "isolate.ts"), "-e", "console.log(JSON.stringify(Object.keys(process.env)))"], {
		encoding: "utf8", timeout: 30_000, env: { ...env, ...Object.fromEntries(caller.map((name) => [name, "fake"])), AMPI_TEST_UNRELATED: "kept" },
	});
	assert.equal(run.status, 0, run.stderr);
	const seen: string[] = JSON.parse(run.stdout);
	assert.deepEqual(caller.filter((name) => seen.includes(name)), []);
	assert.ok(seen.includes("AMPI_TEST_UNRELATED"), "an unrelated variable stays");
});

// A detached maintenance run changes .git/objects after a commit returns; a test that then copies the repository fails.
test("test isolation: a writing Git command in a test process starts no background maintenance", (t) => {
	const repo = mkdtempSync(join(tmpdir(), "ampi-quiet-git-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const trace = join(repo, "trace.log");
	const git = (...args: string[]) => execFileSync("git", ["-C", join(repo, "r"), "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { env: { ...process.env, GIT_TRACE: trace } });
	execFileSync("git", ["init", "-q", join(repo, "r")]);
	writeFileSync(join(repo, "r", "a"), "a\n");
	git("add", "a");
	git("commit", "-qm", "a");
	assert.doesNotMatch(readFileSync(trace, "utf8"), /run_command: .*\b(maintenance run|gc --auto)/);
});

// Hosted CI runs one shard per job; a file missing from every shard would never run there.
test("test runner: the shards of a lane are disjoint and together list every file of the lane once", () => {
	const list = (...args: string[]) => {
		const run = spawnSync(process.execPath, [runner, "--list", ...args], { encoding: "utf8", timeout: 30_000 });
		assert.equal(run.status, 0, run.stdout + run.stderr);
		return run.stdout.split("\n").filter(Boolean);
	};
	for (const lane of ["fast", "full"]) {
		const all = list(lane);
		assert.ok(all.length > 0, lane);
		for (const count of [1, 4, 7]) {
			const shards = Array.from({ length: count }, (_, i) => list(lane, `--shard=${i + 1}/${count}`));
			const union = shards.flat();
			assert.equal(new Set(union).size, union.length, `${lane} ${count}: a file is in two shards`);
			assert.deepEqual([...union].sort(), [...all].sort(), `${lane} ${count}`);
		}
	}
	// The macOS job runs only --engine-cases; a WebKit case outside that set would run on no host.
	const all = list("full"), engine = list("full", "--engine-cases");
	assert.ok(engine.length > 0 && engine.every((file) => all.includes(file)), engine.join(" "));
	const withCases = all.filter((file) => /\bengineSkip\(\w/.test(readFileSync(join(import.meta.dirname, file), "utf8")));
	assert.deepEqual(withCases.filter((file) => !engine.includes(file)), []);
	const bad = spawnSync(process.execPath, [runner, "--list", "--shard=3/2"], { encoding: "utf8", timeout: 30_000 });
	assert.equal(bad.status, 2, bad.stdout + bad.stderr);
});

// 2026-10-31, gate at load 16: `--list` exited before a 4 KiB pipe drained, and the shard check saw a short list.
test("script output: a script that writes more than its pipe holds and calls process.exit loses no byte to a slow reader", () => {
	const child = `require(${JSON.stringify(join(scripts, "stdio-sync.cjs"))}); process.stdout.write("x".repeat(1 << 20)); process.exit(0);`;
	const run = spawnSync("sh", ["-c", 'node -e "$0" | { sleep 1; wc -c; }', child], { encoding: "utf8", timeout: 30_000 });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(Number(run.stdout.trim()), 1 << 20, run.stderr);
});

test("script output: every script that calls process.exit loads stdio-sync.cjs before its first import", () => {
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : /\.(c|m)?[jt]s$/.test(e.name) ? [join(dir, e.name)] : []);
	// demo/cos.ts calls process.exit only inside the source of the stub scripts it writes.
	const bad = walk(scripts).filter((file) => !file.endsWith(join("demo", "cos.ts"))).filter((file) => {
		const text = readFileSync(file, "utf8");
		if (!/process\.exit\(/.test(text)) return false;
		const first = text.split("\n").find((line) => /^(import |const .*require\(|require\()/.test(line)) ?? "";
		return !/^(import |require\()["'](\.\.?\/)+stdio-sync\.cjs["']\)?;$/.test(first);
	}).map((file) => file.slice(scripts.length + 1));
	assert.deepEqual(bad, []);
});
