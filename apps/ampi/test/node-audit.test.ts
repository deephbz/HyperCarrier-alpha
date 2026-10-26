import "./bound.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, section } from "@earendil-works/pi-durable";
import { auditSnapshot } from "../src/plugins/prompt-audit.ts";
import { recordingModels } from "./node-plugin-fixture.ts";

const exec = promisify(execFile);

test("audit replays prompt/tool deltas, reads history and forks, and the existing renderer accepts its snapshot", { timeout: 5000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "ampi-audit-"));
	const { models, model } = recordingModels();
	const alpha = defineTool({ name: "alpha", description: "Read alpha", parameters: Type.Object({ path: Type.String() }), execute: async () => ({}) });
	const beta = defineTool({ name: "beta", description: "Read beta", parameters: Type.Object({}), execute: async () => ({}) });
	const registry = createRegistry();
	registry.install(defineExtension({ name: "audit-fixture", sections: [section("base", () => "Stable base", { tag: false })], tools: [alpha, beta] }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { maxRetries: 0 } } }, ctx);
	try {
		const root = await harness.root(ctx, { agent: { cwd, model: { provider: model.provider, modelId: model.id }, tools: [alpha], instructions: "First instructions" } });
		assert.equal(await auditSnapshot(root, ctx), undefined);
		const turn = async () => assert.equal((await (await root.submit({ type: "input", content: "Record" }, ctx)).wait(ctx)).status, "done");
		await turn();
		const first = (await root.context(ctx)).entries.at(-1)!;
		await root.configure({ tools: [beta], instructions: "Second instructions" }, ctx);
		await turn();
		const snapshot = await auditSnapshot(root, ctx);
		assert.ok(snapshot);
		assert.equal(snapshot.systemPrompt, "Stable base\n\n<instructions>\nSecond instructions\n</instructions>");
		assert.deepEqual(snapshot.activeTools.map((tool) => tool.name), ["beta"]);
		assert.equal(snapshot.activeTools[0]!.description, "Read beta");
		assert.deepEqual(snapshot.activeTools[0]!.parameters, { type: "object", properties: {} });
		assert.equal(snapshot.activeTools[0]!.sourceInfo, null);
		const history = await auditSnapshot(root, ctx, { entryId: first.id });
		assert.ok(history);
		assert.equal(history.systemPrompt, "Stable base\n\n<instructions>\nFirst instructions\n</instructions>");
		assert.deepEqual(history.activeTools.map((tool) => tool.name), ["alpha"]);
		const fork = await root.fork(first.id, { ownership: { kind: "ownerless" } }, ctx);
		const forkSnapshot = await auditSnapshot(fork, ctx);
		assert.equal(forkSnapshot?.integrity.contentSha256, history.integrity.contentSha256);
		assert.equal(forkSnapshot?.provenance.conversationId, String(fork.id));
		await writeFile(join(cwd, "snapshot.json"), JSON.stringify(snapshot));
		const renderer = fileURLToPath(import.meta.resolve("@hypercarrier/systemp-prompt-audit/render-snapshot.mjs"));
		const { stdout } = await exec(process.execPath, [renderer, "snapshot.json"], { cwd, timeout: 2000 });
		const receipt = JSON.parse(stdout);
		assert.match(await readFile(receipt.reviewPath, "utf8"), /Second instructions/);
		assert.match(await readFile(receipt.htmlPath, "utf8"), /Read beta/);
		await root.reset(undefined, ctx);
		assert.equal(await auditSnapshot(root, ctx), undefined, "a reset has no new recorded prompt until its next request");
		await turn();
		assert.equal((await auditSnapshot(root, ctx))?.integrity.contentSha256, snapshot.integrity.contentSha256);
	} finally {
		await harness.close(ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});
