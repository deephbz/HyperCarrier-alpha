import "./bound.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NodeRuntime, parseThreadKey } from "../src/node/runtime.ts";
import { backupStore, restoreStore } from "../src/node/store-file.ts";
import { tempHome } from "./helpers.ts";

async function seed(home: string, name: string) {
	const runtime = new NodeRuntime({ home, agentDir: join(home, "agent") });
	await runtime.start();
	try {
		const { threadId } = await runtime.createThread({ requestId: name, cwd: home, model: { provider: "ampi-sim", modelId: "sim-1" } });
		const { conversation } = await runtime.thread(threadId);
		await conversation.submit({ type: "write", entry: { kind: "test.note", data: { text: "older" } } }, ctx);
		const store = parseThreadKey(threadId).storeId;
		const backup = await backupStore(home, store, name);
		await conversation.submit({ type: "write", entry: { kind: "test.note", data: { text: "newer" } } }, ctx);
		return { threadId, store, backup };
	} finally { await runtime.close(); }
}
async function notes(home: string, threadId: string) {
	const runtime = new NodeRuntime({ home, agentDir: join(home, "agent"), report: () => {} });
	await runtime.start();
	try {
		const { conversation } = await runtime.thread(threadId);
		return (await conversation.entries({ order: "ascending" }, 100, undefined, ctx)).items
			.filter((entry) => entry.kind === "test.note").map((entry) => (entry.data as { text: string }).text);
	} finally { await runtime.close(); }
}

test("restore checks embedded identity without a valid sidecar; older same-store backups still restore", { timeout: 10_000 }, async () => {
	const home = tempHome();
	const target = await seed(home, "target");
	const foreign = await seed(home, "foreign");
	const sidecar = readFileSync(`${foreign.backup}.json`, "utf8");
	for (const value of [undefined, "{bad", JSON.stringify({ ...JSON.parse(sidecar), storeId: target.store })]) {
		if (value === undefined) rmSync(`${foreign.backup}.json`); else writeFileSync(`${foreign.backup}.json`, value);
		await assert.rejects(restoreStore(home, target.store, foreign.backup), /identity|backup of store/, "a missing, malformed or forged sidecar cannot retarget citations");
		assert.deepEqual(await notes(home, target.threadId), ["older", "newer"]);
	}
	rmSync(`${target.backup}.json`);
	await restoreStore(home, target.store, target.backup);
	assert.deepEqual(await notes(home, target.threadId), ["older"]);
});

test("normal open refuses a copied foreign identity instead of rewriting it", { timeout: 10_000 }, async () => {
	const home = tempHome();
	const target = await seed(home, "target"), foreign = await seed(home, "foreign");
	const file = join(home, "threads", target.store, "harness.sqlite");
	writeFileSync(file, readFileSync(foreign.backup));
	const runtime = new NodeRuntime({ home, agentDir: join(home, "agent"), report: () => {}, setTimer: () => {} });
	try {
		await runtime.start();
		assert.equal(runtime.stores.has(target.store), false);
		assert.match(runtime.unavailable(target.store)!.error, /identity.*does not match/);
		// The refused open did not replace the copied identity with the destination folder's ID.
		await assert.rejects(restoreStore(home, target.store, file), /identity/);
	} finally { await runtime.close(); }
});

for (const phase of ["before", "after"]) test(`restore interruption ${phase} rename leaves one complete store`, { timeout: 10_000 }, async () => {
	const home = tempHome();
	const target = await seed(home, `rename-${phase}`);
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/node-restore-child.ts", import.meta.url)), phase, home, target.store, target.backup], {
		stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AMPI_HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") },
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	try {
		await new Promise<void>((resolve, reject) => {
			child.stdout.on("data", (chunk) => { if (String(chunk).includes("rename-barrier")) resolve(); });
			child.once("exit", (code) => reject(new Error(`restore exited ${code}: ${stderr}`)));
		});
		child.kill("SIGKILL"); await exited;
		assert.deepEqual(await notes(home, target.threadId), phase === "before" ? ["older", "newer"] : ["older"]);
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); await exited; }
});
