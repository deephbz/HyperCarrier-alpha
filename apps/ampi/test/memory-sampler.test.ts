import "./bound.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP } from "../src/pi/host.ts";
import { classifyProcesses, sampleTrees } from "./durable-l4/memory.mjs";

test("memory sampler partitions subtrees by canonical role, keeps helpers, and excludes explicit tools", () => {
	const agent = `node -e "eval(Buffer.from('${BOOTSTRAP}','base64').toString())"`;
	const processes = [
		{ pid: 10, ppid: 1, command: "node hub" },
		{ pid: 11, ppid: 10, command: agent },
		{ pid: 12, ppid: 11, command: "agent child" },
		{ pid: 13, ppid: 10, command: "node -e unrelated-helper" },
		{ pid: 14, ppid: 13, command: "helper child" },
		{ pid: 15, ppid: 11, command: "tool" },
		{ pid: 16, ppid: 15, command: "tool child" },
		{ pid: 20, ppid: 1, command: "node runtime" },
		{ pid: 21, ppid: 20, command: agent },
		{ pid: 22, ppid: 20, command: "tool" },
		{ pid: 23, ppid: 22, command: "tool child" },
		{ pid: 30, ppid: 1, command: agent },
	];
	const roots = { hub: 10, node: 20, tools: [15, 22] };
	const { agents, roles } = classifyProcesses(processes, roots);
	assert.deepEqual(agents, [11], "the same argv outside the hub tree is not a hub agent");
	assert.deepEqual([...roles], [
		[10, "hub"], [11, "agent"], [12, "agent"], [13, "helpers"], [14, "helpers"],
		[15, "tools"], [16, "tools"], [20, "node"], [21, "node"], [22, "tools"], [23, "tools"],
	]);
	assert.throws(() => classifyProcesses(processes, { ...roots, node: 999 }), /missing root/);
	assert.throws(() => classifyProcesses(processes, { ...roots, node: 11 }), /overlap/);
	assert.throws(() => classifyProcesses(processes, { ...roots, tools: [30] }), /tool root outside/);
	assert.throws(() => classifyProcesses(processes, { ...roots, tools: [10] }), /cannot replace/);
});

test("memory sampler separates the actual PiHost bootstrap child from the hub process", { skip: process.platform !== "darwin" }, async (t) => {
	// Only these disposable roots are measured. The hub canary launches the real bootstrap with synthetic agent code.
	const hub = spawn(process.execPath, ["-e", `
		const { spawn } = require("node:child_process");
		const agent = spawn(process.execPath, ["-e", "eval(Buffer.from('${BOOTSTRAP}','base64').toString())"], { stdio: ["pipe", "pipe", "ignore"] });
		const stop = () => { agent.kill(); agent.once("exit", () => process.exit()); };
		process.on("SIGTERM", stop); process.on("disconnect", stop);
		agent.stdout.once("data", () => process.send({ agent: agent.pid }));
		agent.stdin.write(JSON.stringify({ cfg: "e30=", code: Buffer.from("process.stdout.write('ready');setInterval(()=>{},1000)").toString("base64") }) + "\\n");
	`], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
	const node = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	t.after(async () => {
		const exited = [hub, node].filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => {
			const done = once(child, "exit"); child.kill(); await done;
		});
		await Promise.all(exited);
	});
	const [message] = await once(hub, "message", { signal: AbortSignal.timeout(2000) });
	const { agent } = message as { agent: number };
	const sample = sampleTrees(fileURLToPath(new URL("./durable-l4/footprint.py", import.meta.url)), { hub: hub.pid!, node: node.pid! });
	assert.deepEqual(sample.rows.filter((row) => row.role === "hub").map((row) => row.pid), [hub.pid]);
	assert.deepEqual(sample.rows.filter((row) => row.role === "agent").map((row) => row.pid), [agent]);
	assert.deepEqual(sample.rows.filter((row) => row.role === "node").map((row) => row.pid), [node.pid]);
	assert.ok(sample.totals.hub > 0 && sample.totals.agent > 0 && sample.totals.node > 0);
	assert.equal(sample.totals.helpers, 0);
	assert.equal(sample.totals.tools, 0);
	assert.equal(sample.rows.reduce((sum, row) => sum + row.bytes, 0), sample.totals.hub + sample.totals.agent + sample.totals.node);
});
