import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The script is untyped .mjs; a URL specifier keeps it out of the TypeScript project.
const hub = new URL("../scripts/verify/hub.mjs", import.meta.url).href;
const { refusingPath } = (await import(hub)) as { refusingPath(dir: string, path?: string): string };
const dir = mkdtempSync(join(tmpdir(), "verify-hub-"));
after(() => rmSync(dir, { recursive: true, force: true }));

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

test("verify hub: PATH refuses every herdr and keeps every other tool", () => {
	// A decoy `herdr` already on PATH stands in for the owner's install; the refusing shim must come first.
	const decoy = join(dir, "decoy");
	mkdirSync(decoy);
	writeFileSync(join(decoy, "herdr"), "#!/bin/sh\necho decoy\n", { mode: 0o755 });
	const path = refusingPath(join(dir, "bin"), `${decoy}:${process.env.PATH}`);
	const herdr = spawnSync("herdr", ["--version"], { env: { ...process.env, PATH: path }, encoding: "utf8" });
	assert.equal(herdr.status, 1);
	assert.match(herdr.stderr, /herdr on PATH is refused/);
	assert.deepEqual(path.split(":").slice(0, 2), [join(dir, "bin"), decoy], "the shim comes first; no directory is dropped");
	assert.match(execFileSync("git", ["--version"], { env: { ...process.env, PATH: path }, encoding: "utf8" }), /^git version/);
});
