import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableViews } from "../src/durable/reader-side.ts";
// @ts-ignore: plain ESM test fixtures over a real pi-durable 1.4.0 store.
import { buildTeam, openFixtureStore } from "../../trace-analytics/test/fixtures/durable-store.mjs";
// @ts-ignore: the real reader service behind a JSON round-trip, as on the wire.
import { serviceNode } from "../../trace-analytics/test/fixtures/durable-node.mjs";

/** Positive Session times vary per run; every other summary field is pinned exactly. */
const scrub = (value: unknown) => JSON.parse(JSON.stringify(value ?? null), (k, v) => (k === "createdAt" || k === "updatedAt") && v > 0 ? "<time>" : v);

// Ownership-derived summaries, for a reader with no Team frame source. Tree: root owns `mid`, and `mid` owns `leaf`,
// so `mid` is a Worker that also owns work. Each step pins the whole summary on every path: summaryFields,
// context.session, and context.sessions (with order).
test("durable ownership summaries: root lead, a Worker that also owns work, an untracked lead, a late update", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-durable-ownership-"));
	const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
	const node = serviceNode(harness);
	const views = new DurableViews({ host: "demo", cacheDir: join(dir, "cache"), node: () => node as never });
	t.after(async () => { await views.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); });
	const key = (c: { id: number }) => `tree-a.${c.id}`;
	const ids = { root: key(root) } as Record<"root" | "mid" | "leaf", string>;
	const summaries = () => {
		const tracked = Object.values(ids).filter((id) => views.has(id));
		return scrub({
			fields: Object.fromEntries(tracked.map((id) => [id, views.summaryFields(id)])),
			session: Object.fromEntries(tracked.map((id) => [id, views.context.session(id)!.summary])),
			sessions: views.context.sessions().map((s) => s.summary),
		});
	};
	// The root has no turn: no spend, preview, or times. A Worker answered one turn.
	const rootFields = (team?: object) => ({ costUsd: 0, spend: { usd: null, covers: ["responses", "failed"] }, spendLabel: "no price reported",
		ref: `demo/pi-durable:${ids.root}`, model: "fixture-sim/sim-1", ...(team ? { team } : {}) });
	const workerFields = (id: string, team: object) => ({ costUsd: 0, spend: { usd: 0, covers: ["responses", "failed", "compaction", "tools"] }, spendLabel: "$0",
		ref: `demo/pi-durable:${id}`, model: "fixture-sim/sim-1", contextTokens: 102, cacheHit: 0, preview: "answer to: worker task: report the build",
		createdAt: "<time>", updatedAt: "<time>", team });
	const summary = (id: string, kind: string, fields: object) => ({ id, title: "", cwd: "", createdAt: 0, updatedAt: 0, kind, activity: "idle", queued: 0, ...fields });

	// The root alone: no ownership, no Team.
	await views.track(ids.root);
	assert.deepEqual(summaries(), {
		fields: { [ids.root]: rootFields() },
		session: { [ids.root]: summary(ids.root, "thread", rootFields()) },
		sessions: [summary(ids.root, "thread", rootFields())],
	});

	const mid = await buildTeam(harness, root);
	const leaf = await buildTeam(harness, mid);
	ids.mid = key(mid); ids.leaf = key(leaf);

	// The leaf before its lead `mid` is tracked: the untracked lead still names the leaf's Team.
	await views.track(ids.leaf);
	const leafFields = workerFields(ids.leaf, { teamId: ids.mid, role: "worker", worker: ids.leaf });
	assert.deepEqual(summaries(), {
		fields: { [ids.root]: rootFields(), [ids.leaf]: leafFields },
		session: { [ids.root]: summary(ids.root, "thread", rootFields()), [ids.leaf]: summary(ids.leaf, "worker", leafFields) },
		sessions: [summary(ids.root, "thread", rootFields()), summary(ids.leaf, "worker", leafFields)],
	});

	// A late update: tracking `mid` makes the already tracked root a lead. `mid` is a Worker first, though it leads `leaf`.
	await views.track(ids.mid);
	const rootLead = rootFields({ teamId: ids.root, role: "lead" });
	const midFields = workerFields(ids.mid, { teamId: ids.root, role: "worker", worker: ids.mid });
	assert.deepEqual(summaries(), {
		fields: { [ids.root]: rootLead, [ids.mid]: midFields, [ids.leaf]: leafFields },
		session: {
			[ids.root]: summary(ids.root, "thread", rootLead),
			[ids.mid]: summary(ids.mid, "worker", midFields),
			[ids.leaf]: summary(ids.leaf, "worker", leafFields),
		},
		sessions: [summary(ids.root, "thread", rootLead), summary(ids.leaf, "worker", leafFields), summary(ids.mid, "worker", midFields)],
	});
});

test("durable ownership summaries: a projection, nested or not, returns what a summary read outside one returns", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-durable-ownership-"));
	const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
	const node = serviceNode(harness);
	const views = new DurableViews({ host: "demo", cacheDir: join(dir, "cache"), node: () => node as never });
	t.after(async () => { await views.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); });
	const mid = await buildTeam(harness, root);
	const leaf = await buildTeam(harness, mid);
	const ids = [root, mid, leaf].map((c: { id: number }) => `tree-a.${c.id}`);
	for (const id of ids) await views.track(id);
	const read = () => ids.map((id) => [views.summaryFields(id), views.context.session(id)!.summary]);
	const outside = read();
	assert.ok(outside.every(([fields]) => fields?.team), "every thread has an ownership-derived Team");
	assert.deepEqual(views.projection(read), outside);
	assert.deepEqual(views.projection(() => views.projection(read)), outside);
	// The lookup ends with the projection: a Worker tracked later gets its Team.
	const late = `tree-a.${(await buildTeam(harness, leaf)).id}`;
	await views.track(late);
	assert.deepEqual(views.summaryFields(late)?.team, { teamId: ids[2], role: "worker", worker: late });
});
