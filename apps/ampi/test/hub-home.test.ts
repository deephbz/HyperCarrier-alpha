import "./bound.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { HubHome, RootOwned } from "../src/hub/home.ts";
import { Hub } from "../src/hub/hub.ts";
import type { PiHost } from "../src/pi/host.ts";
import { lockHome } from "../src/shared/home-lock.ts";
import { tempHome } from "./helpers.ts";

const HOME_MODULE = new URL("../src/hub/home.ts", import.meta.url).href;
const LOCK_MODULE = new URL("../src/shared/home-lock.ts", import.meta.url).href;

/** Runs `body` in a new process with `HubHome`, `RootOwned` and `lockHome` imported; returns what it prints. */
function inOtherProcess(body: string): string {
	const source = `import { HubHome, RootOwned } from ${JSON.stringify(HOME_MODULE)}; import { lockHome } from ${JSON.stringify(LOCK_MODULE)}; ${body}`;
	const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 20_000 });
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim();
}

test("hub home: one owner per home in a process; a release frees it", () => {
	const dir = tempHome();
	const first = HubHome.acquire(dir);
	assert.ok(first instanceof HubHome);
	first.recordPort(4321);
	assert.deepEqual(HubHome.acquire(dir), { pid: process.pid, dir, port: 4321 }, "a second acquire names the owner and gets no home");
	first.release();
	const next = HubHome.acquire(dir);
	assert.ok(next instanceof HubHome, "a released home is free");
	next.release();
});

test("home lock: a second lock call in the owning process keeps the lock, for the hub and the node", () => {
	for (const role of ["hub", "node"]) {
		const dir = tempHome();
		const lock = lockHome(dir, role);
		assert.ok(!("owner" in lock));
		const probe = `const r = lockHome(${JSON.stringify(dir)}, ${JSON.stringify(role)}); console.log("owner" in r ? r.owner : "taken");`;
		assert.equal(inOtherProcess(probe), String(process.pid), `${role}: another process is refused`);
		assert.deepEqual(lockHome(dir, role), { owner: process.pid }, `${role}: the owner's second call is refused from memory`);
		assert.equal(inOtherProcess(probe), String(process.pid), `${role}: the second call did not drop the lock`);
		lock.release();
		assert.equal(inOtherProcess(probe), "taken", `${role}: a release frees it`);
	}
});

test("hub home: hubs on two homes that share a Pi cacheDir or a hub.json directory: the second refuses and names the owner", async () => {
	const cache = join(tempHome(), "pi-cache");
	const config = join(tempHome(), "hub.json");
	const first = HubHome.acquire(tempHome(), config);
	assert.ok(first instanceof HubHome);
	const pi = { id: "box", label: "box", kind: "pi-local" as const, cacheDir: cache };
	const hub = new Hub({ hosts: [pi] }, { home: first, token: "e".repeat(64) });

	const other = JSON.stringify(tempHome());
	assert.equal(inOtherProcess(`const h = HubHome.acquire(${other}, ${JSON.stringify(config)}); console.log(h instanceof HubHome ? "taken" : h.pid);`), String(process.pid), "the hub.json directory");
	assert.equal(
		inOtherProcess(`const h = HubHome.acquire(${other}); try { h.claim(${JSON.stringify(cache)}, "copies"); console.log("taken"); } catch (e) { console.log(e instanceof RootOwned ? e.owner.pid : e.message); }`),
		String(process.pid),
		"the Pi cacheDir",
	);
	const second = HubHome.acquire(tempHome());
	assert.ok(second instanceof HubHome);
	assert.throws(() => new Hub({ hosts: [pi] }, { home: second, token: "e".repeat(64) }), (error) => error instanceof RootOwned && /writes .*pi-cache, which this hub needs for Pi Host box's copies/.test(error.message));
	second.release();

	await hub.close();
	first.release();
	assert.equal(inOtherProcess(`const h = HubHome.acquire(${other}); h.claim(${JSON.stringify(cache)}, "copies"); console.log("taken");`), "taken", "a release frees every root");
});

test("hub home: a directory inside one hub's home that another hub names is still locked: the default pi-cache and a hub.json subdirectory", () => {
	const dir = tempHome();
	const home = HubHome.acquire(dir, join(dir, "conf", "hub.json"));
	assert.ok(home instanceof HubHome);
	assert.equal(
		inOtherProcess(`const h = HubHome.acquire(${JSON.stringify(tempHome())}); try { h.claim(${JSON.stringify(join(dir, "pi-cache"))}, "copies"); console.log("taken"); } catch (e) { console.log(e instanceof RootOwned ? e.owner.pid : e.message); }`),
		String(process.pid),
		"another hub's cacheDir set to this home's pi-cache",
	);
	assert.equal(
		inOtherProcess(`const h = HubHome.acquire(${JSON.stringify(tempHome())}, ${JSON.stringify(join(dir, "conf", "hub.json"))}); console.log(h instanceof HubHome ? "taken" : \`\${h.pid} \${h.use}\`);`),
		`${process.pid} its hub.json (${join(dir, "conf", "hub.json")})`,
		"another hub's --config in this home's conf directory",
	);
	home.release();
});

/**
 * A process that tries to own `dir` and reports the result; an owner holds the home until it is killed. It keeps no
 * reference to the home and collects garbage first, so a lock that lives only as long as its object fails here.
 */
function contender(dir: string) {
	const source = `import { HubHome } from ${JSON.stringify(HOME_MODULE)};
		const result = (() => { const home = HubHome.acquire(${JSON.stringify(dir)}); return home instanceof HubHome ? { owner: true, pid: process.pid } : { owner: false, seen: home.pid }; })();
		globalThis.gc();
		process.send(result, () => { if (!result.owner) process.exit(0); });
		// The IPC channel alone does not keep a process alive; an owner stays until the test kills it.
		if (result.owner) setInterval(() => globalThis.gc(), 20);`;
	const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const result = new Promise<{ owner: boolean; pid?: number; seen?: number }>((resolve, reject) => {
		child.once("message", (message) => resolve(message as never));
		child.once("exit", (code) => reject(new Error(`contender exited ${code} before it reported`)));
	});
	return { child, result };
}

test("hub home: of hubs that start together on one home, exactly one owns it; a killed owner frees it", async (t) => {
	const dir = tempHome();
	const runs = Array.from({ length: 6 }, () => contender(dir));
	t.after(() => { for (const run of runs) run.child.kill("SIGKILL"); });
	const results = await Promise.all(runs.map((run) => run.result));
	const owners = results.filter((result) => result.owner);
	assert.equal(owners.length, 1, JSON.stringify(results));
	const owner = runs[results.indexOf(owners[0]!)]!.child;
	// A loser that raced the owner's pid write sees 0; every other loser names the owner.
	for (const result of results) if (!result.owner) assert.ok(result.seen === owner.pid || result.seen === 0, JSON.stringify(results));

	const exited = new Promise((resolve) => owner.once("exit", resolve));
	owner.kill("SIGKILL");
	await exited;
	const after = HubHome.acquire(dir);
	assert.ok(after instanceof HubHome, "the kernel released the killed owner's lock");
	after.release();
});

test("hub home: a Pi Host keeps its copies in the hub's home; a hub without a home needs the Host's own cacheDir", async () => {
	const home = HubHome.acquire(tempHome());
	assert.ok(home instanceof HubHome);
	const pi = { id: "box", label: "box", kind: "pi-local" as const };
	const hub = new Hub({ hosts: [pi] }, { home, token: "e".repeat(64) });
	assert.ok((hub.links.get("box#pi") as PiHost).cacheDir.startsWith(home.file("pi-cache")));
	await hub.close();
	home.release();
	assert.throws(() => new Hub({ hosts: [pi] }, { token: "e".repeat(64) }), /a hub without a home needs a cacheDir/);
});
