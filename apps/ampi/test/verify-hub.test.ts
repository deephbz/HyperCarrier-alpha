import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { controlRequest } from "../src/arc/service/connection.ts";
import { ownerAlive, processIdentity } from "../scripts/process-owner.cjs";
import { WebSocketServer } from "ws";
import { seedDemoArcs, waitForDemoArc } from "../scripts/demo/cos.ts";

// The script is untyped .mjs; a URL specifier keeps it out of the TypeScript project.
const hub = new URL("../scripts/verify/hub.mjs", import.meta.url).href;
const { refusingPath } = (await import(hub)) as { refusingPath(dir: string, path?: string): string };
const dir = mkdtempSync(join(tmpdir(), "verify-hub-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("demo Arc: source readiness cannot submit before the resident; Arc readers wait without building", async t => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>(resolve => server.once("listening", resolve));
	t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
	const port = (server.address() as { port: number }).port;
	let builds = 0, ready = false;
	server.on("connection", ws => ws.on("message", bytes => {
		const frame = JSON.parse(String(bytes));
		if (frame.t === "sub") {
			ws.send(JSON.stringify({ t: "snap", sid: 1, value: { status: { state: "idle" }, services: [{ host: "devbox", state: "unreachable" }], series: { end: 1 } } }));
			setTimeout(() => {
				if (!ready) assert.equal(builds, 0, "the first source snapshot cannot submit to an unready resident");
				ready = true;
				ws.send(JSON.stringify({ t: "ops", sid: 1, ops: [["s", ["services", 0, "state"], "running"]] }));
			}, 50);
		} else if (frame.t === "req") {
			builds++;
			for (const client of server.clients) client.send(JSON.stringify({ t: "ops", sid: 1, ops: [["s", ["receipt"], { v: 1 }]] }));
		}
	}));
	await Promise.all([seedDemoArcs(port, "synthetic", ["pi:demo"]), waitForDemoArc(port, "synthetic", "pi:demo")]);
	assert.equal(builds, 1, "the reader does not submit another Build");
});

for (const failure of ["service", "response", "request"] as const) test(`demo Arc: ${failure} failure ends the wait with its text`, async t => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>(resolve => server.once("listening", resolve));
	t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
	const text = `Synthetic ${failure} failure`;
	server.on("connection", ws => ws.once("message", () => {
		const frame = failure === "response" ? { t: "res", id: 1, ok: true, value: { outcome: "refused", detail: text } }
			: { t: "snap", sid: 1, value: { status: { state: "idle" }, ...(failure === "service" ? { services: [{ host: "devbox", state: "error", text }] } : { request: { outcome: "refused", detail: text } }) } };
		ws.send(JSON.stringify(frame));
	}));
	const start = Date.now();
	await assert.rejects(waitForDemoArc((server.address() as { port: number }).port, "synthetic", "pi:demo"), { message: text });
	assert.ok(Date.now() - start < 2000, "failure is reported without the 20 s seed deadline");
});

test("demo owner: process generations survive a caller locale change", () => {
	const identity = processIdentity(process.pid);
	assert.ok(identity);
	for (const locale of ["zh_CN.UTF-8", "fr_FR.UTF-8", "C"]) {
		const result: { status: number | null; stdout: string; stderr: string } = spawnSync(process.execPath, ["-e", `
			const { processIdentity, ownerAlive } = require(process.argv[1]);
			console.log(JSON.stringify({ identity: processIdentity(process.ppid), alive: ownerAlive(process.argv[2]) }));
		`, join(import.meta.dirname, "../scripts/process-owner.cjs"), identity], { encoding: "utf8", env: { ...process.env, LANG: locale, LC_ALL: locale } });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { identity, alive: true }, locale);
	}
});

// A killed runner cannot execute its signal handlers or the test's after hooks.
// Exercise the real disposable hub and resident, with no provider environment or owner HOME.
for (const owner of ["driver", "runner", "blocked-hub", "unresponsive-resident", "before-readiness", "file-timeout", "manual", "normal", "failure-close", "guardian-timeout", "non-detached"] as const) test(owner === "manual" ? "demo owner: manual stays persistent and is never stopped" : `demo owner: ${owner} has a bounded disposable lifetime`, async t => {
	const run = mkdtempSync(join(tmpdir(), "ampi-owner-death-"));
	const demo = join(run, "demo"), home = join(run, "home"), log = join(run, "hub.log");
	mkdirSync(home);
	if (owner === "unresponsive-resident") writeFileSync(join(run, "hold-guardian"), "hold before first status observation");
	const env = { PATH: process.env.PATH!, HOME: home, PI_CODING_AGENT_DIR: join(demo, "agent"), DEMO_DIR: demo, DEMO_WEB: "external", PORT: "0", AMPI_PREFLIGHT_DONE: "1", DEMO_LIFETIME: owner === "manual" ? "manual" : "owner", DEMO_GUARDIAN_HOLD: join(run, "hold-guardian"), AMPI_TEST_FILE_TIMEOUT_MS: "5000", DEMO_CLOSE_FAILURE: owner === "failure-close" ? "1" : "" };
	const app = join(import.meta.dirname, "..");
	const script = `
		import { spawn } from 'node:child_process';
		import { openSync, writeFileSync } from 'node:fs';
		writeFileSync(${JSON.stringify(join(run, "worker.pid"))}, String(process.pid));
		const out = openSync(${JSON.stringify(log)}, 'a');
		const child = spawn(process.execPath, ['scripts/pi-demo.ts', '--fixture', 'one'], { cwd: ${JSON.stringify(app)}, env: process.env, detached: ${owner !== "non-detached"}, stdio: ['ignore', out, out] });
		child.unref();
		writeFileSync(${JSON.stringify(join(run, "hub.pid"))}, String(child.pid));
		${owner === "file-timeout" ? `await import(${JSON.stringify(new URL("./bound.ts", import.meta.url).href)});` : ""}
		setInterval(() => {}, 1000);
	`;
	const file = join(run, "owner.mjs");
	writeFileSync(file, script);
	const args = owner === "runner" ? [join(app, "scripts/run-tests.cjs"), file] : [file];
	const processOwner = spawn(process.execPath, args, { env, stdio: "ignore" });
	const live = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
	const marked = (marker = demo) => execFileSync("ps", ["e", "-A", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n")
		.filter(row => row.split(" ").includes(`DEMO_DIR=${marker}`)).map(row => Number(row.trim().split(/\s+/)[0]));
	const owned = new Map<number, string>();
	const remember = (pid: number) => { const identity = processIdentity(pid); if (identity) owned.set(pid, identity); };
	t.after(async () => {
		processOwner.kill("SIGKILL");
		for (const [pid, identity] of owned) if (ownerAlive(identity)) { try { process.kill(pid, "SIGKILL"); } catch {} }
		await new Promise(resolve => setTimeout(resolve, 1500));
		rmSync(run, { recursive: true, force: true });
	});
	const wait = async (check: () => boolean | Promise<boolean>, label: string, timeout = 15_000) => {
		const deadline = Date.now() + timeout;
		while (!await check()) {
			if (Date.now() >= deadline) {
				const pids = marked();
				const states = pids.length ? execFileSync("ps", ["-ww", "-o", "pid=,ppid=,pgid=,stat=,command=", "-p", pids.join(",")], { encoding: "utf8" }) : "none";
				assert.fail(`${label}\nCurrent hub alive=${live(Number(readFileSync(join(run, "hub.pid"), "utf8")))}; descendants:\n${states}`);
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	};
	await wait(() => existsSync(join(run, "hub.pid")), "owner spawned the hub");
	const hubPid = Number(readFileSync(join(run, "hub.pid"), "utf8"));
	const workerPid = Number(readFileSync(join(run, "worker.pid"), "utf8"));
	remember(hubPid); remember(workerPid);
	if (owner === "non-detached") {
		await wait(() => !live(hubPid), "a non-private group fails closed before launching services");
		assert.match(readFileSync(log, "utf8"), /require a private process group/);
		assert.equal(existsSync(join(demo, "agent/ampi-arc")), false);
		return;
	}
	if (owner === "before-readiness") {
		processOwner.kill("SIGKILL");
		await wait(() => marked().filter(pid => pid !== workerPid).length === 0, "pre-readiness owner death leaves no descendants");
		return;
	}
	let resident = 0;
	await wait(async () => {
		try { resident = (await controlRequest(join(demo, "agent/ampi-arc"), { op: "status", refreshAuth: false })).pid ?? 0; return resident > 0; } catch { return false; }
	}, "real demo resident becomes ready", 30_000);
	remember(resident);
	assert.ok(marked().includes(hubPid) && marked().includes(resident), "both processes carry this sandbox marker");
	assert.ok(live(hubPid) && live(resident), "before: one hub and one resident");
	assert.equal(existsSync(join(home, ".pi/agent/auth.json")), false, "sandbox has no provider credentials");
	if (owner !== "unresponsive-resident") await new Promise(resolve => setTimeout(resolve, 1500));
	// The unresponsive case deliberately blocks every status observation before SIGSTOP.
	let guardianPid = 0;
	if (owner === "guardian-timeout") {
		const commands = execFileSync("ps", ["-ww", "-o", "pid=,command=", "-p", marked().join(",")], { encoding: "utf8" });
		const row = commands.split("\n").find(row => row.includes("/demo/owner-guardian.ts"));
		assert.ok(row, "this demo started its guardian");
		guardianPid = Number(row.trim().split(/\s+/)[0]);
		process.kill(guardianPid, "SIGSTOP");
	}
	if (owner === "blocked-hub") process.kill(hubPid, "SIGSTOP");
	if (owner === "unresponsive-resident") process.kill(resident, "SIGSTOP");
	if (owner === "normal" || owner === "failure-close" || owner === "guardian-timeout") { process.kill(hubPid, "SIGTERM"); process.kill(hubPid, "SIGTERM"); }
	else if (owner !== "file-timeout") processOwner.kill("SIGKILL");
	let successor: { pid: number; store: string } | undefined;
	if (owner === "blocked-hub") {
		const other = mkdtempSync(join(tmpdir(), "ampi-owner-successor-"));
		const otherDemo = join(other, "demo"), otherHome = join(other, "home");
		mkdirSync(otherHome);
		const out = openSync(join(other, "hub.log"), "a");
		const child = spawn(process.execPath, ["scripts/pi-demo.ts", "--fixture", "one"], { cwd: app, detached: true,
			env: { ...env, HOME: otherHome, DEMO_DIR: otherDemo, PI_CODING_AGENT_DIR: join(otherDemo, "agent") }, stdio: ["ignore", out, out] });
		t.after(async () => {
			child.kill("SIGTERM");
			await wait(() => marked(otherDemo).length === 0, "unrelated successor and its guardian end during their own teardown");
			rmSync(other, { recursive: true, force: true });
		});
		const store = join(otherDemo, "agent/ampi-arc");
		await wait(async () => { try { const status = await controlRequest(store, { op: "status", refreshAuth: false }); successor = { pid: status.pid, store }; return status.pid > 0; } catch { return false; } }, "late unrelated sandbox starts during cleanup", 30_000);
	}
	if (owner === "manual") {
		await new Promise(resolve => setTimeout(resolve, 1500));
		assert.ok(live(hubPid) && live(resident), "explicit persistent demo survives its launcher");
		const commands = execFileSync("ps", ["-ww", "-o", "command=", "-p", marked().join(",")], { encoding: "utf8" });
		assert.doesNotMatch(commands, /owner-guardian\.ts/, "manual lifetime starts no guardian");
		const out = openSync(join(run, "refused.log"), "a");
		const refused = spawn(process.execPath, ["scripts/pi-demo.ts", "--fixture", "one"], { cwd: app, detached: true,
			env: { ...env, DEMO_LIFETIME: "owner", DEMO_KEEP: "1" }, stdio: ["ignore", out, out] });
		await wait(() => refused.exitCode !== null, "an owner-bound demo refuses the manual demo store");
		assert.notEqual(refused.exitCode, 0, readFileSync(join(run, "refused.log"), "utf8"));
		assert.match(readFileSync(join(run, "refused.log"), "utf8"), /require a fresh store/);
		assert.equal((await controlRequest(join(demo, "agent/ampi-arc"), { op: "status", refreshAuth: false })).pid, resident, "the manual demo Arc still answers after a shared-store refusal");
		process.kill(hubPid, "SIGTERM");
	}
	if (owner === "normal" || owner === "failure-close" || owner === "guardian-timeout") {
		await wait(() => !live(hubPid), `${owner} ends the demo`, owner === "guardian-timeout" ? 20_000 : 15_000);
		assert.deepEqual(marked().filter(pid => pid !== workerPid), [], "demo exit already includes guardian and helper exit on success or failure; the runner needs no grace");
		if (owner === "failure-close") assert.match(readFileSync(log, "utf8"), /Synthetic demo close failure/);
		if (owner === "guardian-timeout") assert.ok(readFileSync(log, "utf8").includes(`Demo guardian (pid ${guardianPid}) did not exit within 15 seconds. Sent SIGKILL to its process group. The demo Arc service for ${join(demo, "agent/ampi-arc")} may still run.`));
	}
	// 15 s cleanup bound: <=1.25 s detection + 6 s source drain + 1 s reap +
	// exact-lock discovery + 0.5 s stop + 2 s resident drain, with scheduling margin.
	await wait(() => marked().filter(pid => pid !== workerPid).length === 0,
		`after ${owner}: no marked descendants; original hub alive=${live(hubPid)}, resident alive=${live(resident)}`, 15_000);
	await new Promise(resolve => setTimeout(resolve, 1200));
	assert.deepEqual(marked().filter(pid => pid !== workerPid), [], "zero hubs, residents, relays, replacements, or guardians after a respawn interval");
	if (successor) assert.equal((await controlRequest(successor.store, { op: "status", refreshAuth: false })).pid, successor.pid, "late unrelated sandbox survives the old sandbox's escalation");
});

const gone = (pid: number) => { try { process.kill(-pid, 0); return false; } catch { return true; } };

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
	test(`verify hub: a ${signal} before cleanup records the run, then kills the hub's process group`, async (t) => {
		const marker = join(dir, `${signal}.receipt`);
		// A detached `sleep` stands in for the demo hub: its own process group, unref'd, as launch() starts pi-demo.
		const script = `
			import { spawn } from "node:child_process";
			import { writeFileSync } from "node:fs";
			const { tieToProcess } = await import(${JSON.stringify(hub)});
			const stand = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
			stand.unref();
			tieToProcess({ pid: stand.pid }, (signal) => {
				process.kill(-stand.pid, 0); // the hub still runs while the run records its failure
				writeFileSync(${JSON.stringify(marker)}, signal);
			});
			console.log(stand.pid);
			setInterval(() => {}, 1000);`;
		const run = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
		const pid = await new Promise<number>((resolve) => run.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
		t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
		assert.ok(pid > 0 && !gone(pid), "the stand-in hub runs");
		const exited = new Promise<number | null>((resolve) => run.on("exit", (code) => resolve(code)));
		run.kill(signal);
		const code = await exited;
		for (let i = 0; i < 50 && !gone(pid); i++) await new Promise((r) => setTimeout(r, 100));
		assert.ok(gone(pid), "no process of the hub's group outlives the run");
		assert.equal(existsSync(marker) && readFileSync(marker, "utf8"), signal, "the run recorded the signal before the kill");
		assert.equal(code, signal === "SIGTERM" ? 143 : 129);
	});
}

test("verify hub: PATH refuses herdr and pi and keeps every other tool", () => {
	// A decoy `herdr` already on PATH stands in for the owner's install; the refusing shim must come first.
	const decoy = join(dir, "decoy");
	mkdirSync(decoy);
	writeFileSync(join(decoy, "herdr"), "#!/bin/sh\necho decoy\n", { mode: 0o755 });
	const path = refusingPath(join(dir, "bin"), `${decoy}:${process.env.PATH}`);
	const herdr = spawnSync("herdr", ["--version"], { env: { ...process.env, PATH: path }, encoding: "utf8" });
	assert.equal(herdr.status, 1);
	assert.match(herdr.stderr, /herdr on PATH is refused/);
	const pi = spawnSync("pi", ["--version"], { env: { ...process.env, PATH: path }, encoding: "utf8" });
	assert.equal(pi.status, 1);
	assert.match(pi.stderr, /pi on PATH is refused/);
	assert.deepEqual(path.split(":").slice(0, 2), [join(dir, "bin"), decoy], "the shim comes first; no directory is dropped");
	assert.match(execFileSync("git", ["--version"], { env: { ...process.env, PATH: path }, encoding: "utf8" }), /^git version/);
});
