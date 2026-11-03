import "./bound.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempHome } from "./helpers.ts";

const runner = join(import.meta.dirname, "..", "scripts", "run-tests.cjs");
const ENV_PATTERN = "AMPI_TEST_FILE_TOKEN=|AMPI_HOME=";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// OF-27: a test file once left a detached process (an autostarted `ampi node`) outside its process group, and the
// process outlived every full run. The runner now ends such a process and fails its file. A file that stops its
// child passes.
test("test runner: a file that leaves a detached process running fails, and the runner ends the process", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ampi-run-tests-"));
    const leaky = tempHome(), clean = tempHome();
    t.after(() => {
        for (const home of [leaky, clean]) {
            try { process.kill(Number(readFileSync(join(home, "child.pid"), "utf8")), "SIGKILL"); } catch {}
            rmSync(home, { recursive: true, force: true });
        }
        rmSync(dir, { recursive: true, force: true });
    });
    const file = (name: string, home: string, stop: boolean) => {
        writeFileSync(join(dir, name), [
            `import { spawn } from "node:child_process";`,
            `import { writeFileSync } from "node:fs";`,
            `import { test } from "node:test";`,
            `test("starts a detached child", async () => {`,
            `\tconst child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });`,
            `\tchild.unref();`,
            `\twriteFileSync(${JSON.stringify(join(home, "child.pid"))}, String(child.pid));`,
            ...(stop ? [
                `\tprocess.kill(child.pid!, "SIGTERM");`,
                `\tfor (;;) { try { process.kill(child.pid!, 0); } catch { break; } await new Promise((resolve) => setTimeout(resolve, 50)); }`,
            ] : []),
            `});`,
        ].join("\n"));
        return join(dir, name);
    };
    const run = spawnSync(process.execPath, [runner, file("leaky.test.ts", leaky, false), file("clean.test.ts", clean, true)], {
        encoding: "utf8",
        env: { ...process.env, AMPI_PREFLIGHT_DONE: "1", AMPI_TEST_CONCURRENCY: "2", AMPI_TEST_FILE_TIMEOUT_MS: "60000" },
    });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1, output);
    const pid = Number(readFileSync(join(leaky, "child.pid"), "utf8"));
    assert.match(output, new RegExp(`STRAY .*leaky\\.test\\.ts: pid ${pid} had not ended when the file did.* Command: `));
    assert.doesNotMatch(output, new RegExp(`STRAY .*${ENV_PATTERN}`), "a STRAY line never prints the environment");
    assert.match(output, /▸ fail .*leaky\.test\.ts/);
    assert.match(output, /failed files: .*leaky\.test\.ts \(left 1 process running\)/);
    assert.match(output, /▸ pass .*clean\.test\.ts/);
    assert.doesNotMatch(output, /STRAY .*clean\.test\.ts/);
    // The killed child has gone to init, which reaps it soon after.
    for (const deadline = Date.now() + 5000; alive(pid) && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(pid), false, "the runner ended the leaky file's child");
});

// A file that kills its detached child in t.after and returns at once can end before the child leaves the process
// table. The runner skips a zombie or an exiting process, so the file passes.
test("test runner: a file that kills its detached child without awaiting its exit passes", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-run-tests-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "killed.test.ts");
	writeFileSync(file, [
		`import { spawn } from "node:child_process";`,
		`import { test } from "node:test";`,
		`test("kills its detached child", (t) => {`,
		`\tconst child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });`,
		`\tchild.unref();`,
		`\tt.after(() => { process.kill(child.pid!, "SIGKILL"); });`,
		`});`,
	].join("\n"));
	const run = spawnSync(process.execPath, [runner, file], {
		encoding: "utf8",
		env: { ...process.env, AMPI_PREFLIGHT_DONE: "1", AMPI_TEST_FILE_TIMEOUT_MS: "60000" },
	});
	const output = run.stdout + run.stderr;
	assert.equal(run.status, 0, output);
	assert.match(output, /▸ pass .*killed\.test\.ts/);
	assert.doesNotMatch(output, /STRAY/);
});
