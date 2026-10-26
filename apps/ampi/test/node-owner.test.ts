import "./bound.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runDaemon, NodeOwnerError } from "../src/node/daemon.ts";
import { NodeRuntime, parseThreadKey } from "../src/node/runtime.ts";
import { backupStore } from "../src/node/store-file.ts";
import { tempHome } from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/node-owner-child.ts", import.meta.url));
function actor(mode: string, home: string, store = "", backup = "") {
	const child = spawn(process.execPath, [fixture, mode, home, store, backup], {
		stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AMPI_HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") },
	});
	const events: string[] = [];
	let wake: (() => void) | undefined;
	let stderr = "", buffer = "";
	const add = (event: string) => { events.push(event); wake?.(); };
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
			if (line.startsWith("{")) add(JSON.parse(line).event);
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const exited = new Promise<void>((resolve) => child.once("exit", (code) => { add(code === 1 && /Stop it first/.test(stderr) ? "refused" : `exit:${code}`); resolve(); }));
	return {
		child, exited,
		advance() { child.stdin.write("x"); },
		async next(): Promise<string> {
			while (!events.length) await new Promise<void>((resolve) => { wake = resolve; });
			const event = events.shift()!;
			assert.ok(!event.startsWith("exit:"), `${event}: ${stderr}`);
			return event;
		},
	};
}

test("atomic owner: a stale PID naming an unrelated live process does not block startup", { timeout: 10_000 }, async () => {
	const home = tempHome();
	writeFileSync(join(home, "node.pid"), `${process.pid}\n`);
	const child = actor("fast", home);
	try {
		assert.equal(await child.next(), "owned");
	} finally {
		if (child.child.exitCode === null) child.child.kill("SIGKILL");
		await child.exited;
	}
});

test("atomic owner: busy names the holder; SIGKILL permits an immediate replacement", { timeout: 10_000 }, async () => {
	const home = tempHome();
	const first = actor("fast", home);
	let next: ReturnType<typeof actor> | undefined;
	try {
		assert.equal(await first.next(), "owned");
		await assert.rejects(runDaemon({ home }), (error: unknown) =>
			error instanceof NodeOwnerError && error.code === "node_owner_busy" && error.owner === first.child.pid);
		first.child.kill("SIGKILL");
		await first.exited;
		next = actor("fast", home);
		assert.equal(await next.next(), "owned", "OS releases the transaction without stale-file cleanup or a grace period");
	} finally {
		for (const active of [first, next]) if (active && active.child.exitCode === null) active.child.kill("SIGKILL");
		await Promise.all([first.exited, next?.exited]);
	}
});

test("atomic owner: failed socket startup releases the owner lock and restores umask", { timeout: 10_000 }, async () => {
	const home = tempHome(), umask = process.umask(), previous = process.env.AMPI_SOCKET;
	try {
		process.env.AMPI_SOCKET = join(home, "missing", "node.sock");
		await assert.rejects(runDaemon({ home, agentDir: join(home, "agent") }), /listen/);
		assert.equal(process.umask(), umask);
		delete process.env.AMPI_SOCKET;
		const daemon = await runDaemon({ home, agentDir: join(home, "agent") });
		await daemon.stop();
	} finally {
		process.umask(umask);
		if (previous === undefined) delete process.env.AMPI_SOCKET;
		else process.env.AMPI_SOCKET = previous;
	}
});

for (const slowMode of ["slow", "restore"]) test(`atomic owner: a contender cannot steal ownership before PID publication (${slowMode})`, { timeout: 10_000 }, async () => {
	const home = tempHome();
	const seed = new NodeRuntime({ home, agentDir: join(home, "agent") });
	const created = await seed.createThread({ cwd: home, model: { provider: "ampi-sim", modelId: "sim-1" } });
	await seed.close();
	const store = parseThreadKey(created.threadId).storeId;
	const backup = await backupStore(home, store, "owner-test");
	writeFileSync(join(home, "node.pid"), "2147483647\n");
	const slow = actor(slowMode, home, store, backup);
	let fast: ReturnType<typeof actor> | undefined;
	try {
		assert.equal(await slow.next(), "before-pid-write");
		fast = actor("fast", home);
		const a = await fast.next();
		assert.equal(a, "refused", "the transaction owns the store before its PID is published");
		slow.advance();
		const b = await slow.next();
		assert.ok(b === "owned" || b === "restored",
			"one actor owns the store even when its diagnostic PID still names a stale process");
	} finally {
		for (const active of [slow, fast]) if (active && active.child.exitCode === null) active.child.kill("SIGKILL");
		await Promise.all([slow.exited, fast?.exited]);
	}
});
