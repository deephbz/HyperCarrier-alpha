import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { parseThreadKey } from "../src/node/runtime.ts";
import { listBackups, PI_DURABLE_VERSION, readStoreFile } from "../src/node/store-file.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

/** Starts a node on `home`, runs `body` with a client, and stops the node. */
async function withNode<T>(home: string, body: (client: TestClient, daemon: Awaited<ReturnType<typeof runDaemon>>) => Promise<T>, options: Parameters<typeof runDaemon>[0] = {}): Promise<T> {
	const daemon = await runDaemon({ home, simTokensPerSecond: 2000, ...options });
	const client = await TestClient.connect(daemon.socket);
	try {
		return await body(client, daemon);
	} finally {
		client.close();
		await daemon.stop();
	}
}

async function newThread(client: TestClient, home: string, requestId: string): Promise<string> {
	const threads = client.sub({ kind: "threads" });
	const { threadId } = await client.req("thread.create", { requestId, cwd: home, model: SIM, place: { workspace: "new", label: requestId }, prompt: "/sim long 2" });
	await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].preview);
	return threadId;
}

const userEntries = async (client: TestClient, threadId: string, n: number) =>
	(await client.until<any>(client.sub({ kind: "thread", threadId }), (v) => v.entries.filter((e: any) => e.kind === "user").length >= n)).entries.filter((e: any) => e.kind === "user").length;

const reasons = (home: string, storeId: string) => listBackups(home, storeId).map((path) => JSON.parse(readFileSync(`${path}.json`, "utf8")).reason as string);

test("store: store.json records the version; a missing or different version backs the store up before the open, the same version does not", async () => {
	const home = tempHome();
	const threadId = await withNode(home, (client) => newThread(client, home, "s-version"));
	const { storeId } = parseThreadKey(threadId);
	const dir = join(home, "threads", storeId);
	assert.equal(readStoreFile(dir)?.piDurable, PI_DURABLE_VERSION);
	assert.deepEqual(reasons(home, storeId), [], "a new store needs no backup");

	await withNode(home, async () => {});
	assert.deepEqual(reasons(home, storeId), [], "the same version opens without a backup");

	rmSync(join(dir, "store.json"));
	await withNode(home, async () => {});
	assert.deepEqual(reasons(home, storeId), ["unknown-version"], "a missing store.json counts as another version");

	writeFileSync(join(dir, "store.json"), JSON.stringify({ piDurable: "0.0.1", openedAt: 1 }));
	await withNode(home, async (client) => assert.equal(await userEntries(client, threadId, 1), 1));
	assert.deepEqual(reasons(home, storeId), ["unknown-version", "from-0.0.1"]);
	assert.equal(readStoreFile(dir)?.piDurable, PI_DURABLE_VERSION, "the open records this build's version");
	const [, last] = listBackups(home, storeId);
	assert.equal(JSON.parse(readFileSync(`${last}.json`, "utf8")).piDurable, "0.0.1", "the sidecar names the version the copy came from");
});

test("store: a store that fails its cold open shows its threads with the failure, and they return when it opens", async () => {
	const home = tempHome();
	const threadId = await withNode(home, (client) => newThread(client, home, "s-cold"));
	const { storeId } = parseThreadKey(threadId);
	const file = join(home, "threads", storeId, "harness.sqlite");
	const setVersion = (version: number | undefined) => {
		const database = new DatabaseSync(file);
		const real = (database.prepare("SELECT version FROM durable_schema").get() as { version: number }).version;
		if (version !== undefined) database.prepare("UPDATE durable_schema SET version = ?").run(version);
		database.close();
		return real;
	};
	const real = setVersion(999);

	const timers: (() => void)[] = [];
	await withNode(
		home,
		async (client, daemon) => {
			const threads = client.sub({ kind: "threads" });
			const failed = (await client.until<any>(threads, (v) => v.threads[threadId]?.lastError)).threads[threadId];
			assert.match(failed.lastError, /storage unavailable: .*SQLite schema version 999 is newer than supported/);
			assert.deepEqual(failed.attention.map((a: any) => a.source), ["node"]);
			assert.match(failed.title, /Unavailable store/);
			const health = await client.req("node.health");
			assert.match(health.stores.find((s: any) => s.id === storeId).unavailable, /newer than supported/);

			setVersion(real);
			timers.shift()!();
			const back = await client.until<any>(threads, (v) => v.threads[threadId] && !v.threads[threadId].lastError);
			assert.doesNotMatch(back.threads[threadId].title, /Unavailable store/);
			assert.equal(daemon.runtime.unavailable(storeId), undefined);
		},
		{ report: () => {}, setTimer: (callback) => void timers.push(callback) },
	);
});
