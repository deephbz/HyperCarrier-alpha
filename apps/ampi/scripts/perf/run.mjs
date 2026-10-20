#!/usr/bin/env node
// AmPi perf loop. See README.md in this directory for commands, the run lock, and the targets.
//
//   perf run --fixture owner|synthetic --scenario startup|switch|idle|index|app [--repeat N] [--code DIR] [--no-trace]
//            [--no-cpu-prof] [--driver browser|probe] [--sessions K] [--label L] [--out DIR] [--wait]
//   perf compare <runA|groupA> <runB|groupB>
//   perf report <runDir>
//   perf fixture owner [--from HOME] | synthetic
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { acquireRunLock, lockStatus, PERF_HOME, RUN_LOCK } from "./lock.mjs";
import { cloneColdHome, fixtureDir, makeOwnerFixture, makeSyntheticFixture, prepareHome, readManifest, recordFill } from "./fixture.mjs";
import { parseTrace, renderSummary, report, writeSummary } from "./report.mjs";
import { compareDirs, renderGroup, summarizeGroup } from "./compare.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OWN_APP = resolve(HERE, "../..");
const SCENARIOS = ["startup", "switch", "idle", "index", "app"];
const epochUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.error("[perf]", ...args);

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) out._.push(a);
		else if (a.startsWith("--no-")) out[a.slice(5)] = false;
		else if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) out[a.slice(2)] = true;
		else out[a.slice(2)] = argv[++i];
	}
	return out;
}

/** The app directory (apps/ampi) of a checkout or of the app itself. */
function appDir(code) {
	if (!code) return OWN_APP;
	const dir = resolve(code);
	for (const candidate of [join(dir, "apps", "ampi"), dir]) if (existsSync(join(candidate, "bin", "ampi.mjs"))) return candidate;
	throw new Error(`No AmPi app under ${dir}`);
}

function git(app, args) {
	try {
		return execFileSync("git", ["-C", app, ...args], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolvePort(port));
		});
	});
}

function rssMb(pid) {
	try {
		return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024;
	} catch {
		return undefined;
	}
}
function childPids(pid) {
	try {
		return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
	} catch {
		return [];
	}
}
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// ---- scenario drivers ----

/**
 * The built-in driver: a WebSocket client that speaks the page's protocol. It has no rendering cost, so its
 * switch times are hub-side only. The browser driver (browser.mjs) replaces it when present.
 */
async function probeScenario({ port, token, scenario, sessions = 10, signal }) {
	const marks = [];
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${token}` } });
	const waiters = new Map();
	let host;
	const hostsSeen = new Promise((resolveHosts) => {
		ws.on("message", (data) => {
			const frame = JSON.parse(String(data));
			if (frame.t === "hosts" && !host) {
				host = frame.hosts.find((h) => h.kind === "pi-local") ?? frame.hosts[0];
				resolveHosts();
			}
			if ((frame.t === "snap" || frame.t === "end") && waiters.has(frame.sid)) {
				waiters.get(frame.sid)(frame);
				waiters.delete(frame.sid);
			}
		});
	});
	await new Promise((ok, fail) => {
		ws.once("open", ok);
		ws.once("error", fail);
	});
	await hostsSeen;
	let sid = 0;
	const subscribe = (topic) => {
		const id = ++sid;
		const answered = new Promise((ok) => waiters.set(id, ok));
		ws.send(JSON.stringify({ t: "sub", sid: id, host: host.id, topic }));
		return { id, answered };
	};
	const threads = subscribe({ kind: "threads" });
	const first = await threads.answered;
	marks.push({ name: "first-data", ts: epochUs() });
	if (scenario === "switch" && first.t === "snap") {
		const list = Object.values(first.value?.threads ?? {}).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, sessions);
		marks.push({ name: "sessions-listed", ts: epochUs(), args: { count: list.length } });
		for (const kind of ["first", "revisit"]) {
			for (const [visit, thread] of list.entries()) {
				if (signal?.aborted) break;
				const start = epochUs();
				const sub = subscribe({ kind: "thread", threadId: thread.id });
				await sub.answered;
				marks.push({ name: `switch-done-${kind}`, ts: start, dur: epochUs() - start, args: { visit } });
				ws.send(JSON.stringify({ t: "unsub", sid: sub.id }));
			}
		}
	}
	if (scenario !== "startup") await sleep(1000);
	marks.push({ name: "scenario-end", ts: epochUs() });
	ws.terminate();
	return { ok: true, marks };
}

/**
 * Waits until the derive queue drains: the Host has loaded its index, the last counter shows pending 0, and no derive
 * job ended for `quietMs` (`idleMs` while no job has run, since the first jobs follow the refresh of every copy).
 */
async function waitDrained(runDir, hubPid, { quietMs = 3000, idleMs = 15_000, timeoutMs = 60 * 60_000, signal } = {}) {
	const deadline = Date.now() + timeoutMs;
	let pending = 0, lastJob = 0, jobs = 0, loadedAt;
	const seen = new Map();
	for (;;) {
		if (signal?.aborted || Date.now() > deadline) return undefined;
		for (const name of readdirSync(runDir).filter((n) => n.startsWith(`trace-${hubPid}-`))) {
			const text = readFileSync(join(runDir, name), "utf8");
			// The files only grow. Parse the complete lines added since the last look.
			const end = text.lastIndexOf("\n") + 1;
			const fresh = text.slice(seen.get(name) ?? 0, end);
			seen.set(name, end);
			for (const e of parseTrace(`[${fresh}`)) {
				if (e.name === "host-loaded") loadedAt ??= Date.now();
				if (e.name === "derive-queue") pending = e.args.pending;
				// The same rule as the report's job count: worker spans such as `init` share the category.
				if (e.cat === "derive" && e.name === "derive" && e.ph === "X") {
					jobs++;
					lastJob = Date.now();
				}
			}
		}
		const quiet = jobs > 0 ? quietMs : idleMs;
		if (loadedAt && pending === 0 && Date.now() - Math.max(lastJob, loadedAt) >= quiet) return { drainedUs: epochUs() - quiet * 1000, jobs };
		await sleep(250);
	}
}

// ---- host load (apps/ampi/AGENTS.md: every timing records CPU idle and memory pressure) ----

/** Summed CPU times of all cores, in ms. Two readings give the idle share of the window between them. */
const cpuTimes = () => cpus().reduce((sum, c) => ({ idle: sum.idle + c.times.idle, total: sum.total + c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle }), { idle: 0, total: 0 });
const idlePct = (a, b) => (b.total > a.total ? Math.round(((b.idle - a.idle) / (b.total - a.total)) * 1000) / 10 : undefined);
const PRESSURE = { 1: "normal", 2: "warn", 4: "critical" };
/** macOS memory pressure level and free share; both reads take a few ms. */
function memoryPressure() {
	const read = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 2000 }); } catch { return ""; } };
	const level = PRESSURE[read("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).trim()];
	const free = /free percentage: (\d+)%/.exec(read("memory_pressure", ["-Q"]))?.[1];
	return { level, freePct: free === undefined ? undefined : Number(free) };
}

// The app scenario launches a separate AmPi.app copy (own bundle id, so its preferences and website data stay apart
// from the installed app) through LaunchServices, as a Dock click does. Each version of the measured checkout's macos/
// sources, edits included, builds its own copy on first use, so an app change is never measured with a stale build.
function ensurePerfApp(app) {
	const hash = createHash("sha256");
	for (const file of (git(app, ["ls-files", "macos"]) ?? "").split("\n").filter(Boolean)) hash.update(`${file}\0`).update(readFileSync(join(app, file)));
	const path = join(PERF_HOME, "app", hash.digest("hex").slice(0, 12), "AmPiPerf.app");
	const perfApp = { path, exec: join(path, "Contents", "MacOS", "AmPi") };
	if (existsSync(perfApp.exec)) return perfApp;
	log(`building ${path}`);
	execFileSync("sh", [join(app, "macos", "scripts", "build-app.sh")], { env: { ...process.env, AMPI_APP: path, AMPI_APP_ID: "dev.hypercarrier.ampi.perf" }, stdio: ["ignore", "ignore", "inherit"] });
	return perfApp;
}

/** App events from the app's own trace file (trace-<pid>-1.json, written by main.swift's AppTrace). */
function appEvents(runDir, hubPid) {
	const events = [];
	for (const f of readdirSync(runDir).filter((f) => /^trace-\d+-1\.json$/.test(f) && !f.startsWith(`trace-${hubPid}-`))) {
		try {
			events.push(...parseTrace(readFileSync(join(runDir, f), "utf8")).filter((e) => e.ph === "i"));
		} catch {}
	}
	return events;
}

/** Launch to first painted Session row. `open` starts the clock: it stands in for the Dock click. */
async function appScenario({ perfApp, port, home, runDir, hubPid, trace, signal }) {
	if (!trace) throw new Error("The app scenario reads its marks from the app trace; run it with tracing on");
	const openUs = epochUs();
	execFileSync("open", ["-n", "-a", perfApp.path, "--env", `AMPI_HOME=${home}`, "--env", `AMPI_HUB_PORT=${port}`, "--env", `AMPI_TRACE=${runDir}`]);
	const hubPage = (e) => e.args?.url === "/";
	let events = [];
	try {
		while (!signal.aborted) {
			events = appEvents(runDir, hubPid);
			if (events.some((e) => e.name === "first-session-row-painted" && hubPage(e))) break;
			await sleep(50);
		}
		await sleep(300);
		events = appEvents(runDir, hubPid);
	} finally {
		// Only this perf copy matches the path; the installed AmPi.app keeps running.
		try { execFileSync("pkill", ["-TERM", "-f", perfApp.exec]); } catch {}
	}
	const at = (name, page) => events.find((e) => e.name === name && (!page || hubPage(e)))?.ts;
	const ms = (ts) => (ts === undefined ? undefined : Math.round((ts - openUs) / 100) / 10);
	const stats = {
		"open→process-start": ms(at("app-process-start")),
		"open→did-finish-launching": ms(at("did-finish-launching")),
		"open→window-shown": ms(at("window-shown")),
		"open→status-paint": ms(events.find((e) => e.name === "first-contentful-paint" && !hubPage(e))?.ts),
		"open→hub-page-load-start": ms(at("hub-page-load-start")),
		"open→hub-first-contentful-paint": ms(at("first-contentful-paint", true)),
		"open→first-session-row-painted": ms(at("first-session-row-painted", true)),
	};
	const marks = [{ name: "app-open", ts: openUs }, ...events.map((e) => ({ name: `app:${e.name}`, ts: e.ts }))];
	return { ok: stats["open→first-session-row-painted"] !== undefined, marks, stats };
}

// ---- one run ----

export async function runOnce(options) {
	const { fixture, scenario, runDir, trace = true, cpuProf = true, sessions = 10, driver: wanted, code, fill = false, label = "perf" } = options;
	if (scenario === "index" && !trace) throw new Error("The index scenario reads the drain from the trace; run it with tracing on");
	const loopStart = performance.now();
	const app = appDir(code);
	rmSync(runDir, { recursive: true, force: true });
	mkdirSync(runDir, { recursive: true });
	// Warm scenarios run in the fixture's home in place (see fixture.mjs). `index` clones a fresh cold home; the fill
	// clones it into the fixture's home and keeps it. The lock covers the clone, the run, and the teardown.
	const cold = scenario === "index";
	const home = fill || !cold ? join(fixtureDir(fixture), "home") : join(PERF_HOME, "homes", `${fixture}-cold`);
	const manifest = readManifest(fixture);
	// The measured checkout's driver first: its web marks belong to that build.
	const browserHook = [join(app, "scripts", "perf", "browser.mjs"), join(HERE, "browser.mjs")].find((f) => existsSync(f)) ?? join(HERE, "browser.mjs");
	const driver = scenario === "index" ? "none" : scenario === "app" ? "app" : wanted ?? (existsSync(browserHook) ? "browser" : "probe");
	const perfApp = scenario === "app" ? ensurePerfApp(app) : undefined;
	const receipt = {
		commit: git(app, ["rev-parse", "HEAD"]),
		dirty: Boolean(git(app, ["status", "--porcelain", "-uno", "--ignore-submodules=all", "--", "."])),
		node: process.version,
		fixture: { id: manifest.id, kind: manifest.kind, frozenAt: manifest.frozenAt, copies: manifest.copies },
		args: { fixture, scenario, trace, cpuProf, sessions, driver, code: code ? "external" : "self" },
		startedAt: new Date().toISOString(),
		load: { before: Math.round(loadavg()[0] * 10) / 10, memoryBefore: memoryPressure() },
		external: {},
		scenario: { name: scenario, driver },
	};
	let token;
	receipt.external.setupMs = Math.round(performance.now() - loopStart);
	let hub, leftHome;
	try {
		if (cold) {
			mkdirSync(join(home, ".."), { recursive: true });
			const cloneStart = performance.now();
			cloneColdHome(fixture, home);
			receipt.external.cloneMs = Math.round(performance.now() - cloneStart);
		}
		prepareHome(fixture, home);
		const port = await freePort();
		const env = { ...process.env, AMPI_HOME: home };
		delete env.AMPI_HUB_CONFIG;
		delete env.AMPI_TRACE;
		if (trace) env.AMPI_TRACE = runDir;
		const nodeArgs = cpuProf ? ["--cpu-prof", `--cpu-prof-dir=${runDir}`] : [];
		const cpuStart = cpuTimes();
		receipt.external.spawnUs = epochUs();
		hub = spawn(process.execPath, [...nodeArgs, join(app, "bin", "ampi.mjs"), "hub", "--port", String(port)], { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] });
		receipt.hubPid = hub.pid;
		let stderr = "";
		hub.stdout.resume();
		hub.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
		const exited = new Promise((ok) => hub.once("exit", (code, signal) => ok({ code, signal })));
		let peak = 0;
		const sampler = setInterval(() => (peak = Math.max(peak, rssMb(hub.pid) ?? 0)), 200);
		// Health: the first 200 from /api/health.
		for (const deadline = Date.now() + 60_000; ; ) {
			if (hub.exitCode !== null) throw new Error(`hub exited before health: ${stderr.replace(/k=[0-9a-f]+/g, "k=…").slice(-500)}`);
			try {
				const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
				if (res.status === 200) {
					receipt.external.healthUs = epochUs();
					// The hub creates the key when the home has none; read it after the hub has started.
					token = readFileSync(join(home, "hub.token"), "utf8").trim();
					break;
				}
			} catch {}
			if (Date.now() > deadline) throw new Error("hub never answered /api/health");
			await sleep(5);
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), scenario === "index" ? 60 * 60_000 : 60_000);
		try {
			if (scenario === "index") {
				const drained = await waitDrained(runDir, hub.pid, { signal: controller.signal });
				Object.assign(receipt.external, drained ?? {});
				receipt.scenario.ok = Boolean(drained);
				await sleep(2000);
			} else if (driver === "app") {
				const result = await appScenario({ perfApp, port, home, runDir, hubPid: hub.pid, trace, signal: controller.signal });
				Object.assign(receipt.scenario, result);
				log(Object.entries(result.stats).map(([k, v]) => `${k} ${v ?? "—"} ms`).join("  "));
			} else if (driver === "browser") {
				const { runScenario } = await import(browserHook);
				const url = `http://127.0.0.1:${port}/?k=${token}`;
				const result = await runScenario({ url, origin: `http://127.0.0.1:${port}`, runDir, scenario, sessions, epochUs, signal: controller.signal, log });
				Object.assign(receipt.scenario, { ok: result.ok, marks: result.marks ?? [], ...(result.stats ? { stats: result.stats } : {}), ...(result.error ? { error: String(result.error).slice(0, 300) } : {}) });
			} else {
				const result = await probeScenario({ port, token, scenario, sessions, signal: controller.signal });
				Object.assign(receipt.scenario, { ok: result.ok, marks: result.marks });
				receipt.external.probeFirstDataUs = result.marks.find((m) => m.name === "first-data")?.ts;
			}
		} catch (error) {
			Object.assign(receipt.scenario, { ok: false, error: String(error?.message ?? error).replace(/k=[0-9a-f]+/g, "k=…").slice(0, 300) });
		} finally {
			clearTimeout(timeout);
		}
		receipt.external.agentPids = childPids(hub.pid).flatMap((pid) => [pid, ...childPids(pid)]);
		receipt.external.idleRssMb = rssMb(hub.pid);
		clearInterval(sampler);
		receipt.external.peakRssMb = Math.max(peak, receipt.external.idleRssMb ?? 0);
		// Stop: SIGTERM, then a forced kill after 10 s.
		const stopStart = performance.now();
		hub.kill("SIGTERM");
		const forced = setTimeout(() => {
			receipt.external.stopForced = true;
			hub.kill("SIGKILL");
		}, 10_000);
		await exited;
		clearTimeout(forced);
		receipt.external.stopMs = performance.now() - stopStart;
		// CPU idle over the measured window: spawn to hub exit.
		receipt.load.cpuIdlePct = idlePct(cpuStart, cpuTimes());
		receipt.load.memoryAfter = memoryPressure();
		// Agents write their trace on exit after the hub's SIGTERM. Give them 1 s, then kill what is left.
		for (const deadline = Date.now() + 1000; receipt.external.agentPids.some(alive) && Date.now() < deadline; ) await sleep(20);
		for (const pid of receipt.external.agentPids) if (alive(pid)) process.kill(pid, "SIGKILL");
	} finally {
		if (hub && hub.exitCode === null && hub.signalCode === null) hub.kill("SIGKILL");
		// A discarded cold home moves aside under the lock (a rename); the next run may clone into the path at once.
		if (cold && !fill && existsSync(home)) {
			leftHome = `${home}.done-${process.pid}-${Date.now()}`;
			renameSync(home, leftHome);
		}
	}
	receipt.load.after = Math.round(loadavg()[0] * 10) / 10;
	if (leftHome) rmSync(leftHome, { recursive: true, force: true });
	writeFileSync(join(runDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
	const reportStart = performance.now();
	const summary = report(runDir);
	summary.external.reportMs = Math.round(performance.now() - reportStart);
	summary.external.loopWallMs = Math.round(performance.now() - loopStart);
	// The receipt keeps both, so `perf report` rebuilds the same summary.
	Object.assign(receipt.external, { reportMs: summary.external.reportMs, loopWallMs: summary.external.loopWallMs });
	writeFileSync(join(runDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
	return writeSummary(runDir, summary);
}

// ---- commands ----

/** One lock for a whole group, so no other runner measures between its runs. A held lock stops the command unless --wait. */
function takeRunLock(label, args) {
	return acquireRunLock(label, { wait: args.wait === true, onWait: (h) => log(`waiting for the run lock held by ${h.label} (pid ${h.pid})`) });
}

/** The lock path, its holder, and the queued waiters, each on its own lines. */
function renderLockStatus() {
	const { holder, waiters } = lockStatus();
	const who = (o, at) => `${o.label} (pid ${o.pid}${at ? `, since ${new Date(at).toISOString()}` : ""})`;
	const lines = [`lock: ${RUN_LOCK}`, `holder: ${holder ? `${who(holder, holder.started)}${holder.dead ? " — pid dead, stale after the grace period" : ""}` : "none"}`];
	lines.push(waiters.length ? "waiting:" : "waiting: none", ...waiters.map((w) => `  ${who(w, w.since)}`));
	return lines.join("\n");
}

async function run(args) {
	const fixture = args.fixture ?? "synthetic";
	const scenario = args.scenario ?? "startup";
	if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario ${scenario}; use ${SCENARIOS.join("|")}`);
	const repeat = Number(args.repeat ?? 1);
	const label = args.label ?? `${fixture}-${scenario}`;
	const release = await takeRunLock(label, args);
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
	const group = resolve(args.out ?? join(PERF_HOME, "runs", `${stamp}-${label}`));
	const summaries = [];
	try {
		readManifest(fixture);
		mkdirSync(group, { recursive: true });
		for (let i = 1; i <= repeat; i++) {
			const runDir = join(group, `r${String(i).padStart(2, "0")}`);
			const s = await runOnce({
				fixture, scenario, runDir, label, code: args.code, sessions: Number(args.sessions ?? 10),
				trace: args.trace !== false, cpuProf: args["cpu-prof"] !== false && args.trace !== false, driver: args.driver,
			});
			summaries.push(s);
			const verdicts = s.limits.map((l) => `${l.id} ${l.value ?? "–"}${l.pass === false ? "✗" : ""}`).join("  ");
			console.log(`${runDir}  ${verdicts}`);
		}
	} finally {
		release();
	}
	const aggregate = summarizeGroup(summaries);
	writeFileSync(join(group, "group.json"), `${JSON.stringify({ label, fixture, scenario, runs: summaries.map((_, i) => `r${String(i + 1).padStart(2, "0")}`), aggregate }, null, 2)}\n`);
	writeFileSync(join(group, "summary.md"), renderGroup(label, summaries, aggregate));
	console.log(`\n${readFileSync(join(group, repeat === 1 ? "r01/summary.md" : "summary.md"), "utf8")}`);
	console.log(`Run group: ${group}\nOpen ${join(group, "r01", "trace.json")} in https://ui.perfetto.dev`);
}

async function fixtureCommand(args) {
	const id = args._[1];
	if (id === "synthetic") makeSyntheticFixture({});
	else if (id === "owner") {
		const from = args.from ?? "/tmp/ampi-startup-port-home-final";
		if (!existsSync(join(from, "hub.json"))) throw new Error(`No AmPi home at ${from}`);
		log("freezing the owner fixture: Session roots, home, Herdr replay");
		makeOwnerFixture({ from, log });
	} else throw new Error("usage: perf fixture owner [--from HOME] | synthetic");
	// Warm fill: one cold index on this checkout, then its home becomes the fixture's warm home.
	const runDir = join(fixtureDir(id), "fill");
	log("filling the working set (cold index)");
	const release = await takeRunLock(`fixture-${id}`, args);
	let s;
	try {
		s = await runOnce({ fixture: id, scenario: "index", runDir, fill: true, cpuProf: false, label: `fixture-${id}` });
	} finally {
		release();
	}
	if (!s.index?.complete || !s.index.jobs) throw new Error(`The fill did not derive and drain; see ${runDir}/summary.md`);
	const manifest = recordFill(id, { jobs: s.index?.jobs, seconds: s.index?.seconds, complete: s.index?.complete, commit: s.run.commit });
	console.log(JSON.stringify(manifest, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "run";
try {
	if (command === "run") await run(args);
	else if (command === "compare") console.log(compareDirs(args._[1], args._[2]));
	else if (command === "report") console.log(renderSummary(report(args._[1])));
	else if (command === "fixture") await fixtureCommand(args);
	else if (command === "lock") console.log(renderLockStatus());
	else throw new Error(`Unknown command ${command}`);
} catch (error) {
	log(error.message);
	process.exitCode = 1;
}
