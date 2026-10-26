import "../isolate.ts";
// Pause after lock acquisition, before PID publication. A contender must still fail without wall-clock sleeps.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [mode, home, store, backup] = process.argv.slice(2);
const pidPath = join(home!, "node.pid");
const signal = (event: string) => process.stdout.write(`${JSON.stringify({ event, pid: process.pid })}\n`);
const pause = (event: string) => { signal(event); fs.readSync(0, Buffer.alloc(1), 0, 1, null); };
const write = fs.writeFileSync;
if (mode !== "fast") {
	fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
		if (path === pidPath) pause("before-pid-write");
		return Reflect.apply(write, fs, [path, ...args]);
	}) as typeof fs.writeFileSync;
	syncBuiltinESMExports();
}
if (mode === "restore") {
	process.argv = [process.execPath, "ampi", "node", "restore", store!, backup!];
	await import("../../src/cli.ts");
	signal("restored");
} else {
	const { runDaemon } = await import("../../src/node/daemon.ts");
	try {
		const daemon = await runDaemon({ home, agentDir: join(home!, "agent"), report: () => {} });
		signal("owned");
		await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
		await daemon.stop();
	} catch (error) {
		if (!/already runs|Lost the node lock/.test(String(error))) throw error;
		signal("refused");
	}
}
