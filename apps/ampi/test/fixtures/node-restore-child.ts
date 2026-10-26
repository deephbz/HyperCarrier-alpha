import "../isolate.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [phase, home, store, backup] = process.argv.slice(2);
const target = join(home!, "threads", store!, "harness.sqlite");
const rename = fs.renameSync;
const barrier = () => { process.stdout.write("rename-barrier\n"); fs.readSync(0, Buffer.alloc(1), 0, 1, null); };
fs.renameSync = (from, to) => {
	if (to === target && phase === "before") barrier();
	rename(from, to);
	if (to === target && phase === "after") barrier();
};
syncBuiltinESMExports();
process.argv = [process.execPath, "ampi", "node", "restore", store!, backup!];
await import("../../src/cli.ts");
