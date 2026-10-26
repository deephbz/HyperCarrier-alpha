#!/usr/bin/env node
// AmPi command line. The sources are TypeScript run directly by Node's type stripping (Node >= 22.18).
// The compile cache keeps the stripped and compiled modules on disk (Node's default directory under the OS temp dir),
// so a restart skips about 1 s of type stripping and compilation. Node checks each source's hash, so an edit
// invalidates its entry. NODE_DISABLE_COMPILE_CACHE=1 turns it off; NODE_COMPILE_CACHE=<dir> moves it.
import { enableCompileCache } from "node:module";
import { NODE_RANGE, nodeIsPatched } from "./node-floor.mjs";

if (!nodeIsPatched(process.versions.node)) {
	process.stderr.write(`ampi: Node ${process.versions.node} is not supported. Use Node ${NODE_RANGE} (${process.execPath}).\n`);
	process.exit(1);
}
enableCompileCache?.();
await import("../src/cli.ts");
