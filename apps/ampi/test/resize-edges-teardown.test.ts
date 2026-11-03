import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { maintainHost } from "../src/arc/service/client.ts";
import { demoSessions, seededArc } from "./resize-edges-fixture.ts";

let resident: number | undefined;
after(() => {
	if (!resident) return;
	const rows = execFileSync("ps", ["-axo", "pid=,stat="], { encoding: "utf8" }).trim().split("\n");
	const state = rows.map(row => row.trim().split(/\s+/)).find(([pid]) => Number(pid) === resident)?.[1];
	assert.ok(!state || /^[ZX]/.test(state), `demo Arc resident ${resident} outlived fixture teardown (${state})`);
});

test("demo fixture stops its detached Arc resident after abrupt hub exit", async () => {
	await seededArc();
	const status = await maintainHost({ id: "devbox", label: "devbox", kind: "pi-local", agentConfig: { agentDir: dirname(demoSessions()) } }, { op: "status" });
	assert.equal(status.running, true);
	resident = status.pid;
	const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n");
	const hub = rows.map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).find(row => row && Number(row[2]) === process.pid && /scripts\/pi-demo\.ts/.test(row[3]!));
	assert.ok(hub, "the fixture owns the demo hub process");
	// A crashed hub cannot run its own maintenance. The detached resident survives this group signal.
	process.kill(-Number(hub[1]), "SIGKILL");
});

test("demo fixture completes resident stop after its hub needs escalation", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-teardown-liveness-"));
	const pidFile = join(dir, "resident.pid"), completed = join(dir, "completed"), probe = join(dir, "probe.test.ts");
	t.after(() => {
		if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
		rmSync(dir, { recursive: true, force: true });
	});
	writeFileSync(probe, `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, test } from "node:test";
import { demoSessions, seededArc } from ${JSON.stringify(new URL("./resize-edges-fixture.ts", import.meta.url).href)};
import { maintainHost } from ${JSON.stringify(new URL("../src/arc/service/client.ts", import.meta.url).href)};
after(() => writeFileSync(${JSON.stringify(completed)}, "fixture after hook completed"));
test("hub cannot handle SIGTERM", async () => {
 await seededArc();
 const status = await maintainHost({ id: "devbox", label: "devbox", kind: "pi-local", agentConfig: { agentDir: dirname(demoSessions()) } }, { op: "status" });
 assert.equal(status.running, true);
 writeFileSync(${JSON.stringify(pidFile)}, String(status.pid));
 const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\\n");
 const hub = rows.map(row => row.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.*)$/)).find(row => row && Number(row[2]) === process.pid && /scripts\\/pi-demo\\.ts/.test(row[3]));
 assert.ok(hub);
 process.kill(-Number(hub[1]), "SIGSTOP");
});
`);
	const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--test", "--experimental-test-isolation=none", probe], { timeout: 50_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
	assert.ok(existsSync(completed), `fixture after hook did not settle before file exit:\n${stdout}${stderr}`);
	const pid = Number(readFileSync(pidFile, "utf8"));
	const rows = execFileSync("ps", ["-axo", "pid=,stat="], { encoding: "utf8" }).trim().split("\n");
	const state = rows.map(row => row.trim().split(/\s+/)).find(([found]) => Number(found) === pid)?.[1];
	assert.ok(!state || /^[ZX]/.test(state), `demo Arc resident ${pid} outlived escalated fixture teardown (${state})`);
});
