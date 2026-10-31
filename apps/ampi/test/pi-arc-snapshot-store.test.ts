import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type ModelPurpose, resolveHelperModel, useHubConfig } from "../src/hub/helper-models.ts";
import { cosDemo } from "../scripts/demo/cos.ts";
import { ask } from "../src/pi/ask.ts";
import { WorkingSet } from "../src/pi/working-set.ts";
import type { Source } from "../src/pi/working-set-types.ts";
import { buildArc, cosArc, type ArcValue } from "../src/pi/views/cos-arc.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";
import { HELPER_MODELS } from "./pi-host-fixtures.ts";

useHubConfig(undefined, HELPER_MODELS);

// Build arc over the real working-set store: a worker commit that lands between two Rarebit pages must not mix
// versions inside one Build. The Session head, both pages and the chunk evidence come from one store read.

const line = (o: unknown) => JSON.stringify(o) + "\n";
const at = (n: number) => new Date(1_770_000_000_000 + n * 1000).toISOString();
const user = (id: string, parentId: string | null, text: string, n: number) => ({ type: "message", id, parentId, timestamp: at(n), message: { role: "user", content: [{ type: "text", text }] } });
const stop = (id: string, parentId: string, text: string, n: number) => ({ type: "message", id, parentId, timestamp: at(n), message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 20, output: 10, cost: { total: 0.1 } } } });

test("arc build store snapshot: a worker commit between two Rarebit pages leaves the Build on its start version (failure: a mixed read failed or mixed the Build)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-arc-store-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	cosDemo({ dir, agentDir: join(dir, "agent"), now: Date.now(), sessions: {} });
	const model = [process.execPath, join(dir, "cos-model.cjs")];
	const source: Source = { host: "fixture", cacheDir: join(dir, "cache"), path: "/synthetic/session.jsonl", file: join(dir, "copy.jsonl") };
	mkdirSync(source.cacheDir);
	// Two owner turns and 450 agent stops: more Rarebit messages than one 400-item page holds, in few chunks.
	let body = line({ type: "session", id: "fixture-session", cwd: "/synthetic", timestamp: at(0) }) + line(user("u0", null, "Fix the parser.", 1));
	let parent = "u0";
	for (let i = 1; i <= 450; i++) {
		if (i === 225) { body += line(user("u1", parent, "Now the cache.", 2 * i)); parent = "u1"; }
		body += line(stop(`a${i}`, parent, `Step ${i} landed.`, 2 * i + 1)); parent = `a${i}`;
	}
	writeFileSync(source.file, body);
	const store = new WorkingSet(source.host, source.cacheDir);
	t.after(() => store.close());
	const built = (await store.refresh(source))!;
	assert.ok(built.rarebit.count > 400, `two Rarebit pages: ${built.rarebit.count}`);
	assert.ok(built.arc.chunks.length > 0);
	const v1 = built.version;

	// A second writer stands in for the derivation worker: each first-page read commits a new Session version.
	const writer = new DatabaseSync(join(source.cacheDir, "working-set.sqlite"), { timeout: 5000 });
	t.after(() => writer.close());
	let commits = 0;
	const commit = () => { commits++; writer.prepare("UPDATE sessions SET data=json_set(data,'$.version',?) WHERE path=?").run(`v-next-${commits}`, source.path); };
	const session = (): PiViewSession => {
		const data = store.load(source.path)!;
		return { threadId: "fixture-session", ref: "fixture/fixture-session", sourceVersion: data.version, data, bytes: data.bytes, summary: { cwd: "/synthetic" },
			rarebits: (before?: string, fullText?: boolean) => { const page = store.rarebits(source.path, 1, before, fullText); if (!before) commit(); return page; },
			arcEvidence: (ids: string[]) => store.arcEvidence(source.path, ids, data.version),
			entryTimes: (ids: string[]) => store.entryTimes(source.path, ids) } as unknown as PiViewSession;
	};
	const context = (name: string, snapshot: PiViewContext["snapshot"]) => {
		const state = join(dir, name); mkdirSync(state);
		return { state, ctx: { host: "fixture", stateDir: () => state, session, lease: () => () => {}, invalidate() {}, snapshot, model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o), ask: (req: Parameters<PiViewContext["ask"]>[0]) => ask(req, model) } as unknown as PiViewContext };
	};
	const settle = async (ctx: PiViewContext) => {
		for (let i = 0; i < 800; i++) {
			const v = cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: "fixture-session" }) as ArcValue;
			if (v.job?.state !== "running") return v;
			await new Promise((r) => setTimeout(r, 25));
		}
		throw new Error("Build arc did not finish");
	};

	const ok = context("snapshot", (read) => store.snapshot(read));
	buildArc(ok.ctx, session());
	const v = await settle(ok.ctx);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	assert.equal(commits, 1, "the worker committed during the Build's read");
	const receipt = JSON.parse(readFileSync(join(ok.state, readdirSync(ok.state).find((f) => /^[0-9a-f]{64}\.json$/.test(f))!), "utf8"));
	assert.equal(receipt.sourceVersion, v1, "the receipt names the version the Build read");

	// Control: without one store read, each attempt pairs a page with a newer head.
	const mixed = context("no-snapshot", (read) => read());
	buildArc(mixed.ctx, session());
	const w = await settle(mixed.ctx);
	assert.equal(w.job?.state, "error");
	assert.equal(w.job?.lastError?.code, "source");
	assert.match(w.job?.lastError?.message ?? "", /version v-next-\d+; the snapshot has (?:v-next-\d+|[0-9a-f]+)\./);
});
