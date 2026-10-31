import "./bound.ts";
// The durable node's wire contract (node-design.md, R1 wire contract). `NodeOps` in src/shared/protocol.ts declares
// every op the node serves; the type assertions below run under `npm run typecheck`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { ops, readerOps } from "../src/node/server.ts";
import { hydrate } from "../src/plugins.ts";
import type { NodeOpName, NodeOps, NodeTopicValues } from "../src/shared/protocol.ts";
import { TestClient, tempHome } from "./helpers.ts";
import type { Escapes } from "./wire-contract.test.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

// ---- NoEscape over node results ----
// `thread.history` keeps the node's native page until the reader carries Pi-shaped entries (node-design.md step 8).
// The reader wire forwards pi-durable records and documents as stored; only the hub's DurableViews reads them.
type Deferred = "thread.history" | `reader.${string}`;
type Found = { [K in Exclude<NodeOpName, Deferred>]: Escapes<NodeOps[K]["result"], K> }[Exclude<NodeOpName, Deferred>] | Escapes<NodeTopicValues["login"], "topic login">;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export const noEscape: Equal<Found, never> = true;

/** Every node op name, checked against `NodeOps` both ways. */
const NODE_OPS = {
	"node.info": true, "node.restart": true, "node.health": true, "node.backup": true, "audit.snapshot": true, "store.reopen": true, "models.list": true, "prompts.list": true,
	"accounts.list": true, "accounts.login": true, "accounts.answer": true, "accounts.cancel": true, "accounts.logout": true,
	"thread.create": true, "thread.submit": true, "thread.abort": true, "thread.withdraw": true, "thread.editQueued": true, "thread.close": true, "thread.compact": true,
	"thread.commands": true, "thread.command": true,
	"thread.configure": true, "thread.rename": true, "thread.archive": true, "thread.fork": true, "thread.history": true,
	"thread.images": true, "compact.records": true, "git.changes": true, "fs.dirs": true,
	"reader.open": true, "reader.entries": true, "reader.fence": true, "reader.raw": true, "reader.cancel": true, "reader.close": true,
} satisfies Record<NodeOpName, true>;

test("node wire: the node serves every declared op and nothing else", async () => {
	// A plugin can answer its own ops (NodePlugin.ops), beside the node's op table.
	const plugins = await hydrate();
	const served = new Set([...ops.keys(), ...readerOps, ...plugins.flatMap((plugin) => Object.keys(plugin.ops ?? {}))]), declared = new Set(Object.keys(NODE_OPS));
	assert.deepEqual([...served].filter((op) => !declared.has(op)), [], "handlers without a NodeOps entry");
	assert.deepEqual([...declared].filter((op) => !served.has(op)), [], "NodeOps entries without a handler");
});

test("node wire: terminals are gone; an undeclared op or topic answers unsupported and no frame carries a terminal", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 5000, plugins: await hydrate() });
	try {
		const client = await TestClient.connect(daemon.socket);
		for (const op of ["term.open", "term.input", "term.resize", "term.close"])
			await assert.rejects(client.req(op, { termId: "x", cwd: home }), (error: { code?: string }) => error.code === "unsupported", op);
		const terms = client.sub({ kind: "terms" } as never);
		const term = client.sub({ kind: "term", termId: "x" } as never);
		// An unknown topic ends before the handler's first await, so the reply to a later request follows both ends.
		await client.req("node.info");
		assert.ok(client.ended.has(term));
		assert.match(client.ended.get(terms)!, /does not serve the terms topic/);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { requestId: "wire-1", cwd: home, model: SIM, prompt: "/sim bash echo wire" });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.preview !== undefined);
		const ack = await client.req("thread.submit", { threadId, content: "again" });
		assert.equal(ack.via, "node");
		assert.match(ack.submission, /^\d+$/);
		assert.equal(client.lines.some((line) => /"termId"|"terms"|node-pty/.test(line)), false, "a frame names a terminal");
		client.close();
	} finally {
		await daemon.stop();
	}
});
