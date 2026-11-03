import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
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
