import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempHome } from "./helpers.ts";

const BIN = join(import.meta.dirname, "..", "bin", "ampi.mjs");

/** Every file below `dir`. */
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(dir, f)).isFile()) : []);

test("startup: the ampi command keeps its compiled modules in Node's compile cache", (t) => {
	const home = tempHome();
	t.after(() => rmSync(home, { recursive: true, force: true }));
	// The default cache directory is under the OS temp dir, which TMPDIR moves into this scratch home.
	const env = { HOME: home, AMPI_HOME: join(home, "ampi"), TMPDIR: home, PATH: process.env.PATH };
	execFileSync(process.execPath, [BIN, "version"], { env, encoding: "utf8" });
	const cached = files(join(home, "node-compile-cache"));
	// One entry per compiled module: the CLI's TypeScript graph is dozens of modules.
	assert.ok(cached.length >= 20, `expected the CLI's modules in the compile cache, found ${cached.length}`);
	const off = tempHome();
	t.after(() => rmSync(off, { recursive: true, force: true }));
	execFileSync(process.execPath, [BIN, "version"], { env: { ...env, TMPDIR: off, NODE_DISABLE_COMPILE_CACHE: "1" }, encoding: "utf8" });
	assert.deepEqual(files(join(off, "node-compile-cache")), [], "NODE_DISABLE_COMPILE_CACHE turns the cache off");
});
