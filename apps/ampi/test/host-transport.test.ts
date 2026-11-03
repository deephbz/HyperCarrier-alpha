import "./bound.ts";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { BOOTSTRAP, PiHost } from "../src/pi/host.ts";
import { tempHome } from "./helpers.ts";

// Exercise the link at its process boundary. No SSH command reaches a real host.
test("pi link preserves SSH argv and retry delays for attempts 0..8", async (t) => {
	const children: (EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean })[] = [];
	const launches: { command: string; args: string[] }[] = [];
	const spawn = t.mock.method(childProcess, "spawn", (command: string, args: string[]) => {
		launches.push({ command, args });
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
			kill() { child.emit("close", 1, null); return true; },
		});
		child.stdin.resume();
		children.push(child);
		return child;
	});
	syncBuiltinESMExports();
	t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
	const home = tempHome();
	const common = { id: "far", label: "far", target: "user@far", sshArgs: ["-p", "2222"] };
	const link = new PiHost({ ...common, kind: "pi-ssh", cacheDir: home, remoteNode: "/opt/node/bin/node" });
	const state = () => link.state;
	t.after(async () => { await link.stop(); });
	link.start();
	const until = Date.now() + 10_000;
	while (!children.length) {
		assert.ok(Date.now() < until, "link must launch");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const bootstrap = `eval(Buffer.from('${BOOTSTRAP}','base64').toString())`;
	const expectedArgs = ["-T", "-C", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-p", "2222", "--", "user@far", `sh -lc ${JSON.stringify(`exec /opt/node/bin/node -e ${JSON.stringify(bootstrap)}`)}`];
	assert.deepEqual(launches[0], { command: "ssh", args: expectedArgs });
	const hello = { t: "hello", host: "far", pid: 4242 };
	children.at(-1)!.stdout.write(`${JSON.stringify(hello)}\n`);
	assert.equal(state().status, "connected");
	assert.equal(state().attempts, 0);

	const scheduled: { delay: number; run(): void; timer: ReturnType<typeof setTimeout> }[] = [];
	const realTimeout = globalThis.setTimeout;
	const timers = t.mock.method(globalThis, "setTimeout", (run: () => void, delay: number) => {
		const timer = realTimeout(() => {}, 1_000_000);
		scheduled.push({ delay, run, timer });
		return timer;
	});
	t.after(() => { timers.mock.restore(); for (const task of scheduled) clearTimeout(task.timer); });
	const expectedDelays = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
	for (const [attempt, delay] of expectedDelays.entries()) {
		assert.equal(state().attempts, attempt);
		children.at(-1)!.emit("close", 1, null);
		const down = state();
		assert.equal(down.status, "disconnected");
		assert.equal(down.retryAt! - down.since, delay);
		const retry = scheduled.at(-1)!;
		assert.equal(retry.delay, delay);
		if (attempt < 8) { clearTimeout(retry.timer); retry.run(); }
	}
	for (const launch of launches) assert.deepEqual(launch, { command: "ssh", args: expectedArgs });
	await link.stop();
});
