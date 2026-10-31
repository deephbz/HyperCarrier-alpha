#!/usr/bin/env node
// Runs AmPi test files, one `node --test` process per file, in a bounded pool.
//
//   node scripts/run-tests.cjs [fast|full|exhaustiveOnly]   a lane from test-lanes.json (default fast)
//   node scripts/run-tests.cjs <file>...                    probe files; npm test -- <file> does the same
//   --shard=k/N   run the k-th of N disjoint parts of those files (hosted CI runs one part per job)
//   --list        print the files the run would start, one per line, and exit
//   --engine-cases  keep only the files with browser-engine cases: files that import test/engines.ts, directly or
//                 through a local helper (the macOS job runs these with AMPI_TEST_ENGINES=webkit)
//
// Every shard computes the same partition: the files sorted by their cost hint (`costs` in test-lanes.json: rounded seconds
// of the file in a hosted Linux CI shard; a file under 2 s has none and counts 1 s), each placed on the part with the least
// hinted cost so far.
// The N parts together run every file once. Hints only balance the parts; correctness never depends on them.
//
// Every run has two bounds, so no test run can hang (a probe run once hung for 3 h):
//   AMPI_TEST_TIMEOUT_MS       per test, passed to --test-timeout (default 60000)
//   AMPI_TEST_FILE_TIMEOUT_MS  per file (default 3 x the test bound). `--test-timeout` fails the test body, but an
//                              open handle keeps the file alive, so the runner ends the file's process group.
// AMPI_TEST_CONCURRENCY sets the pool size (default 8). AMPI_TEST_START_CONCURRENCY starts the pool smaller, and
// SIGUSR2 raises it to the full size: the gate holds the lane at 2 while the browser journeys run. The longest files start first, from the wall times of
// earlier runs in ~/.cache/ampi-test/times.json. Each file's output prints in one block when the file ends;
// AMPI_TEST_QUIET=1 prints a passing file as its one status line. Failures stay visible: there are no retries.
// Timeouts are their own class in the totals, beside the load average, because load is their usual cause.
require("./stdio-sync.cjs");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const testDir = path.join(root, "test");
const LANES = new Set(["fast", "full", "exhaustiveOnly"]);
const fail = (message) => { console.error(message); process.exit(2); };
const positive = (name, fallback) => {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value < 1) fail(`Invalid ${name}: ${process.env[name]}`);
	return value;
};
const concurrency = positive("AMPI_TEST_CONCURRENCY", 8);
const testTimeout = positive("AMPI_TEST_TIMEOUT_MS", 60_000);
const fileTimeout = positive("AMPI_TEST_FILE_TIMEOUT_MS", 3 * testTimeout);
let limit = Math.min(concurrency, positive("AMPI_TEST_START_CONCURRENCY", concurrency)), pooling = false;
// Installed before any work: SIGUSR2's default action ends the process.
process.on("SIGUSR2", () => { limit = concurrency; if (pooling) pump(); });
const quiet = process.env.AMPI_TEST_QUIET === "1";
const load = () => os.loadavg().map((n) => n.toFixed(0)).join("/");

const options = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
let shard, list = false, engineCases = false;
for (const option of options) {
	const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(option);
	if (match && Number(match[1]) <= Number(match[2])) shard = { index: Number(match[1]), count: Number(match[2]) };
	else if (option === "--list") list = true;
	else if (option === "--engine-cases") engineCases = true;
	else fail(`Unknown option: ${option} (options: --shard=k/N with 1 <= k <= N, --list, --engine-cases)`);
}
// `npm test -- <file>` arrives as `fast <file>`: files after a lane name replace the lane.
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (args.length > 1 && LANES.has(args[0])) args.shift();
const lane = args.length === 0 ? "fast" : args.length === 1 && LANES.has(args[0]) ? args[0] : undefined;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "test-lanes.json"), "utf8"));
const name = (file) => (file.startsWith(testDir + path.sep) ? path.relative(testDir, file) : file);
const cost = (file) => manifest.costs?.[name(file)] ?? 1;
let files;
if (lane) {
	files = (lane === "full" ? [...manifest.fast, ...manifest.exhaustiveOnly] : manifest[lane]).map((file) => path.join(testDir, file));
} else {
	files = args.map((arg) => [path.resolve(arg), path.join(testDir, arg)].find((file) => fs.existsSync(file)) ?? fail(`No test file or lane: ${arg} (lanes: ${[...LANES].join(", ")})`));
}
if (engineCases) {
	const imports = (file) => [...fs.readFileSync(file, "utf8").matchAll(/^(?:import|export)\b[^;]*?["'](\.\.?\/[^"']+\.ts)["']/gm)].map((match) => path.resolve(path.dirname(file), match[1]));
	const engines = path.join(testDir, "engines.ts");
	const reaches = (file, seen = new Set()) => !seen.has(file) && (seen.add(file), imports(file).some((next) => next === engines || (fs.existsSync(next) && reaches(next, seen))));
	files = files.filter((file) => reaches(file));
}
if (shard) {
	const parts = Array.from({ length: shard.count }, () => ({ cost: 0, files: [] }));
	const order = [...files].sort((a, b) => cost(b) - cost(a) || name(a).localeCompare(name(b)));
	for (const file of order) {
		const part = parts.reduce((least, next) => (next.cost < least.cost ? next : least));
		part.cost += cost(file);
		part.files.push(file);
	}
	const part = parts[shard.index - 1];
	if (!list) console.log(`shard ${shard.index}/${shard.count}: ${part.files.length} of ${files.length} files, ${part.cost} s of hinted cost`);
	files = part.files;
}
if (list) {
	for (const file of files) console.log(name(file));
	process.exit(0);
}
if (files.length === 0) process.exit(0);
if (process.env.AMPI_PREFLIGHT_DONE !== "1") {
	const preflight = spawnSync(process.execPath, [path.join(__dirname, "test-preflight.cjs")], { cwd: path.resolve(root, "../.."), stdio: "inherit" });
	if (preflight.status !== 0) process.exit(preflight.status ?? 1);
}

const timesPath = path.join(os.homedir(), ".cache", "ampi-test", "times.json");
let times = {};
try { times = JSON.parse(fs.readFileSync(timesPath, "utf8")); } catch {}
// Unknown files first: a new file can be the slowest. A fresh hosted runner has no times; the cost hints order it.
const expected = (file) => times[name(file)] ?? (manifest.costs?.[name(file)] ?? Infinity) * 1000;
const queue = [...files].sort((a, b) => expected(b) - expected(a));

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "ampi-test-runner-"));
const env = { ...process.env };
// Playwright's browser cache holds browser binaries only; a WebKit test needs it under the per-file HOME.
env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
// The one thing a test takes from the owner's home: the installed Pi program, the anchor of test/node-prompt-parity.test.ts.
const piVersion = path.join(os.homedir(), ".pi", "agent", "install", "current-version");
if (!env.AMPI_PI_DIST && fs.existsSync(piVersion))
	env.AMPI_PI_DIST = path.join(path.dirname(piVersion), "releases", fs.readFileSync(piVersion, "utf8").trim(), "node_modules", "@earendil-works", "pi-coding-agent", "dist");
// A runner started from inside a test inherits node:test's context, which makes each child skip its files.
delete env.NODE_TEST_CONTEXT;
// test/bound.ts bounds bare runs; here it fires 5 s after the runner, which also ends the file's child processes.
env.AMPI_TEST_FILE_TIMEOUT_MS = String(fileTimeout + 5000);
const running = new Set();
const killGroup = (child, signal) => { try { process.kill(-child.pid, signal); } catch {} };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
	for (const child of running) killGroup(child, "SIGKILL");
	fs.rmSync(isolatedHome, { recursive: true, force: true });
	process.exit(130);
});

const COUNTS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
const total = Object.fromEntries(COUNTS.map((key) => [key, 0]));
const failed = [];
let timedOut = 0, testTimeouts = 0;
const started = Date.now();

function runFile(file) {
	return new Promise((done) => {
		const fileStarted = Date.now();
		// Each file gets its own HOME and Pi agent directory: a test never reads the owner's home or another file's.
		const home = fs.mkdtempSync(path.join(isolatedHome, "home-"));
		const agentDir = path.join(home, ".pi", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		// detached: the file and every process it spawns share one process group, which a timeout ends together.
		// Isolation none: this process already is the file's process. Under Node 22 the default isolation also puts
		// --test-timeout on the whole file, so a file whose tests together outlast one test bound failed in CI.
		const child = spawn(process.execPath, ["--test", "--experimental-test-isolation=none", `--test-timeout=${testTimeout}`, "--test-reporter=spec", file], { cwd: root, env: { ...env, HOME: home, PI_CODING_AGENT_DIR: agentDir }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		running.add(child);
		let output = "", timeout;
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		const timer = setTimeout(() => {
			timeout = `TIMEOUT ${name(file)}: still running after ${fileTimeout / 1000} s at load ${load()}; ended its process group. A test or an open handle never ended.`;
			killGroup(child, "SIGTERM");
			setTimeout(() => killGroup(child, "SIGKILL"), 2000).unref();
		}, fileTimeout);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			running.delete(child);
			killGroup(child, "SIGKILL");
			const ms = Date.now() - fileStarted;
			const slow = output.match(new RegExp(`test timed out after ${testTimeout}ms`, "g"))?.length ?? 0;
			testTimeouts += slow;
			if (!quiet || timeout || code !== 0) process.stdout.write(output.endsWith("\n") || !output ? output : `${output}\n`);
			if (timeout) {
				timedOut++;
				failed.push(`${name(file)} (timeout)`);
				console.log(timeout);
			} else {
				for (const key of COUNTS) total[key] += Number(output.match(new RegExp(`^ℹ ${key} (\\d+)$`, "m"))?.[1] ?? 0);
				if (code !== 0) failed.push(`${name(file)} (${slow ? `${slow} test timeout${slow > 1 ? "s" : ""} at load ${load()}` : `exit ${code ?? signal}`})`);
				else times[name(file)] = Math.round(times[name(file)] ? (times[name(file)] + ms) / 2 : ms);
			}
			console.log(`▸ ${timeout ? "timeout" : code === 0 ? "pass" : "fail"} ${name(file)} ${(ms / 1000).toFixed(1)} s`);
			done();
		});
	});
}

let active = 0;
function pump() {
	while (active < limit && queue.length) {
		active++;
		runFile(queue.shift()).then(() => { active--; if (active || queue.length) pump(); else finish(); });
	}
}
pooling = true;
pump();

function finish() {
	fs.rmSync(isolatedHome, { recursive: true, force: true });
	try {
		fs.mkdirSync(path.dirname(timesPath), { recursive: true });
		fs.writeFileSync(timesPath, `${JSON.stringify(times, null, 1)}\n`);
	} catch {}
	console.log(`\nfiles ${files.length} · timed out ${timedOut} · ${COUNTS.map((key) => `${key} ${total[key]}`).join(" · ")} · test timeouts ${testTimeouts} · wall ${((Date.now() - started) / 1000).toFixed(1)} s · concurrency ${concurrency} · load ${load()}`);
	if (failed.length) console.log(`failed files: ${failed.join(", ")}`);
	process.exit(failed.length ? 1 : 0);
}
