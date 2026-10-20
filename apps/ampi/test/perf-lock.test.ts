import "./bound.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-ignore: the perf scripts are plain ESM.
import { acquireRunLock } from "../scripts/perf/lock.mjs";

const fast = { pollMs: 10 };
const queue = { wait: true, pollMs: 10 };
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function lockDir(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "ampi-perf-lock-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "run.lock");
}
function hold(lock: string, pid: number, label = "other") {
	mkdirSync(lock);
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid, label, started: Date.now() }));
}
const owner = (lock: string) => JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid!;

test("perf lock: a second runner refuses at once while a live runner holds the lock, and leaves it in place", async (t) => {
	const lock = lockDir(t);
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { stdio: "ignore" });
	t.after(() => child.kill());
	hold(lock, child.pid!, "mem-verify");
	const started = Date.now();
	await assert.rejects(acquireRunLock("second", { lock, timeoutMs: 5_000, graceMs: 50, ...fast }), /held by mem-verify/);
	assert.ok(Date.now() - started < 1_000);
	assert.equal(owner(lock).pid, child.pid);
});

test("perf lock: a refusing runner still clears a dead-pid lock after the grace period", async (t) => {
	const lock = lockDir(t);
	hold(lock, deadPid(), "crashed");
	const release = await acquireRunLock("runner", { lock, graceMs: 100, ...fast });
	assert.equal(owner(lock).label, "runner");
	release();
});

test("perf lock: the lock goes when its holder is stopped by a signal or exits without releasing", async (t) => {
	const lock = lockDir(t);
	const url = JSON.stringify(new URL("../scripts/perf/lock.mjs", import.meta.url).href);
	const endings = [
		["SIGTERM", "setTimeout(() => {}, 10_000);"],
		["exit", "await new Promise((resolve) => process.stdin.once('data', resolve)); process.exit(3);"],
	] as const;
	for (const [how, tail] of endings) {
		const script = [
			`import { acquireRunLock } from ${url};`,
			`await acquireRunLock("holder", { lock: ${JSON.stringify(lock)} });`,
			'console.log("held");',
			tail,
		].join("\n");
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"] });
		t.after(() => child.kill());
		const exited = once(child, "exit");
		await once(child.stdout!, "data");
		assert.equal(owner(lock).pid, child.pid, how);
		if (how === "SIGTERM") child.kill("SIGTERM");
		else child.stdin.end("exit\n");
		const [code, signal] = await exited;
		assert.equal(existsSync(lock), false, how);
		assert.deepEqual([code, signal], how === "SIGTERM" ? [null, "SIGTERM"] : [3, null]);
	}
});

test("perf lock: two runners take turns, and the second waits while the first holds", async (t) => {
	const lock = lockDir(t);
	const first = await acquireRunLock("first", { lock, ...fast });
	let second: (() => void) | undefined;
	const waiting = acquireRunLock("second", { lock, ...queue }).then((release: () => void) => (second = release));
	await settle(150);
	assert.equal(second, undefined);
	assert.equal(owner(lock).label, "first");
	first();
	await waiting;
	assert.equal(owner(lock).label, "second");
	second!();
	assert.equal(existsSync(lock), false);
});

test("perf lock: a waiter never takes or removes a lock whose holder pid is alive", async (t) => {
	const lock = lockDir(t);
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { stdio: "ignore" });
	t.after(() => child.kill());
	hold(lock, child.pid!, "mem-verify");
	await assert.rejects(acquireRunLock("waiter", { lock, timeoutMs: 300, graceMs: 50, ...queue }), /held by mem-verify/);
	assert.equal(owner(lock).pid, child.pid);
});

test("perf lock: a lock without a readable owner is never taken over", async (t) => {
	const lock = lockDir(t);
	mkdirSync(lock);
	await assert.rejects(acquireRunLock("waiter", { lock, timeoutMs: 300, graceMs: 50, ...queue }), /still held/);
	assert.equal(existsSync(lock), true);
});

test("perf lock: a dead-pid lock is cleared only after the grace period, as a holder may still be tearing down", async (t) => {
	const lock = lockDir(t);
	hold(lock, deadPid(), "teardown");
	let taken = false;
	const waiting = acquireRunLock("waiter", { lock, graceMs: 400, ...fast }).then((release: () => void) => { taken = true; return release; });
	await settle(200);
	assert.equal(taken, false);
	assert.equal(owner(lock).label, "teardown");
	const release = await waiting;
	assert.equal(owner(lock).label, "waiter");
	release();
});

test("perf lock: the grace period restarts when the holder rewrites its owner", async (t) => {
	const lock = lockDir(t);
	hold(lock, deadPid(), "bench-1");
	let taken = false;
	const waiting = acquireRunLock("waiter", { lock, graceMs: 300, ...queue }).then((release: () => void) => { taken = true; return release; });
	await settle(200);
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: deadPid(), label: "bench-2", started: Date.now() }));
	await settle(200);
	assert.equal(taken, false);
	(await waiting)();
});

test("perf lock: release removes only the releaser's own lock", async (t) => {
	const lock = lockDir(t);
	const release = await acquireRunLock("mine", { lock, ...fast });
	// Someone else's lock now stands at the path.
	rmSync(lock, { recursive: true });
	hold(lock, process.pid, "theirs");
	release();
	assert.equal(owner(lock).label, "theirs");
});

test("perf lock: processes racing to clear one stale lock never hold it together", async (t) => {
	const lock = lockDir(t);
	hold(lock, deadPid(), "dead");
	const log = join(lock, "..", "holds.log");
	const script = `import { appendFileSync } from "node:fs";
import { acquireRunLock } from ${JSON.stringify(new URL("../scripts/perf/lock.mjs", import.meta.url).href)};
const release = await acquireRunLock("racer", { lock: ${JSON.stringify(lock)}, wait: true, graceMs: 100, pollMs: 1 });
appendFileSync(${JSON.stringify(log)}, "+\\n");
await new Promise((resolve) => setTimeout(resolve, 80));
appendFileSync(${JSON.stringify(log)}, "-\\n");
release();`;
	const racers = Array.from({ length: 4 }, () => spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "inherit"] }));
	const codes = await Promise.all(racers.map(async (child) => (await once(child, "exit"))[0]));
	assert.deepEqual(codes, [0, 0, 0, 0]);
	assert.equal(readFileSync(log, "utf8"), "+\n-\n".repeat(4));
	assert.equal(existsSync(lock), false);
});

test("perf lock: `perf run` refuses to start while a live runner holds the lock", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ampi-perf-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const lock = join(home, "run.lock");
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { stdio: "ignore" });
	t.after(() => child.kill());
	hold(lock, child.pid!, "mem-verify");
	const runner = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/perf/run.mjs", import.meta.url)), "run", "--fixture", "synthetic", "--scenario", "startup"], { env: { ...process.env, AMPI_PERF_HOME: home }, encoding: "utf8", timeout: 20_000 });
	assert.equal(runner.status, 1);
	assert.match(runner.stderr, /held by mem-verify/);
	assert.equal(owner(lock).pid, child.pid);
	assert.equal(existsSync(join(home, "runs")), false);
});

test("perf lock: a clearer that judged a lock stale before another runner cleared it never moves the newer lock", async (t) => {
	// The schedule behind the racing-clearers failures: A judges the dead lock stale and stalls; B clears it and holds;
	// A resumes. A must not move B's lock, so C finds the path held, and at most one runner holds at any instant.
	const lock = lockDir(t);
	hold(lock, deadPid(), "dead");
	const holders = new Set<string>();
	let most = 0;
	const take = async (label: string, options: object) => {
		const release = await acquireRunLock(label, { lock, graceMs: 50, ...fast, ...options });
		holders.add(label);
		most = Math.max(most, holders.size);
		return () => {
			holders.delete(label);
			release();
		};
	};
	let atClear!: () => void, resume!: () => void;
	const stalled = new Promise<void>((resolve) => (atClear = resolve));
	const go = new Promise<void>((resolve) => (resume = resolve));
	let cRefused: unknown;
	const pause = async (point: string) => {
		if (point === "before-clear" && !holders.size) {
			atClear();
			await go;
		}
		// A moved the lock that stood at the path. A runner arriving now must find it held.
		if (point === "after-move" && holders.has("B")) await take("C", {}).catch((error) => (cRefused = error));
	};
	const a = take("A", { wait: true, pause });
	a.catch(() => {}); // Checked below, after the holder count.
	await stalled;
	const releaseB = await take("B", { wait: true });
	resume();
	await settle(100);
	assert.equal(most, 1, `holders at once: ${most}`);
	assert.equal(owner(lock).label, "B");
	await assert.rejects(take("C", {}), /held by B/);
	assert.equal(cRefused, undefined, "A never reached a moved live lock");
	releaseB();
	const releaseA = await a;
	assert.equal(owner(lock).label, "A");
	releaseA();
	assert.equal(existsSync(lock), false);
	assert.equal(most, 1);
});

test("perf lock: `perf lock` names the true holder and lists a waiting runner apart", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ampi-perf-home-"));
	const lock = join(home, "run.lock");
	const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20_000)"], { stdio: "ignore" });
	hold(lock, holder.pid!, "mem-verify");
	const run = fileURLToPath(new URL("../scripts/perf/run.mjs", import.meta.url));
	const env = { ...process.env, AMPI_PERF_HOME: home };
	const waiter = spawn(process.execPath, [run, "run", "--fixture", "synthetic", "--scenario", "startup", "--label", "queued-run", "--wait"], { env, stdio: ["ignore", "ignore", "pipe"] });
	// The waiter must exit before `home` goes: a removed lock is free, so a live waiter takes it inside `home`.
	t.after(async () => {
		for (const child of [waiter, holder]) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
		rmSync(home, { recursive: true, force: true });
	});
	let said = "";
	for await (const chunk of waiter.stderr!) if ((said += chunk).includes("waiting for the run lock")) break;
	const status = spawnSync(process.execPath, [run, "lock"], { env, encoding: "utf8" }).stdout;
	const [, holderLine, ...waiting] = status.trim().split("\n");
	assert.match(holderLine, new RegExp(`^holder: mem-verify \\(pid ${holder.pid},`));
	assert.doesNotMatch(holderLine, new RegExp(`pid ${waiter.pid}`));
	assert.equal(waiting[0], "waiting:");
	assert.match(waiting.join("\n"), new RegExp(`pid ${waiter.pid},`));
	assert.equal(owner(lock).pid, holder.pid);
});
