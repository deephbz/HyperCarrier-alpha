import "./bound.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALL_COVERS, historySpend, spendLabel, sumSpend, summarySpend, unreadSpend } from "../src/shared/spend.ts";
import { activeSpend, laneSpend } from "../web/src/views/cos/totals.ts";
import { money } from "../web/src/util.ts";

const pi = (usd: number | null) => ({ costUsd: usd ?? 0, spend: historySpend(usd) });
const durable = (usd: number | null) => ({ costUsd: usd ?? 0, spend: { usd, covers: [...ALL_COVERS] } });
const total = (rows: { costUsd: number; spend?: any }[]) => spendLabel(sumSpend(rows.map(summarySpend)));

test("spend label: a total that mixes backends names what some of its Sessions leave out", () => {
	assert.equal(total([pi(0.75), durable(0.75)]), "$1.50 (some Sessions exclude compaction, tool model calls)");
	assert.equal(total([pi(0.75), pi(0.75)]), "$1.50 (excludes compaction, tool model calls)");
	assert.equal(total([durable(0.75), durable(0.75)]), money(1.5), "a durable-only total is the bare amount");
	assert.equal(total([{ costUsd: 0.25 }]), money(0.25), "an older Host's summary without spend shows its bare amount");
	assert.equal(total([]), "$0");
});

test("spend label: a Pi row with no reported price reads as a durable one does", () => {
	assert.equal(spendLabel(historySpend(null)), "no price reported");
	assert.equal(spendLabel(historySpend(null)), spendLabel(durable(null).spend));
	assert.equal(spendLabel(historySpend(0)), "$0 (excludes compaction, tool model calls)", "a reported $0 stays a price");
});

test("spend label: a Timeline lane is unpriced only when no member reported a price", () => {
	assert.equal(spendLabel(laneSpend([{ priced: true }, { priced: false }], 0.25)), "$0.25 (excludes compaction, tool model calls)");
	assert.equal(spendLabel(laneSpend([{ priced: false }, { priced: false }], 0)), "no price reported");
	assert.equal(spendLabel(laneSpend([{}], 0.25)), "$0.25 (excludes compaction, tool model calls)", "an older Host's lane counts as priced");
});

test("spend label: the suffix words come from the one spend rule", () => {
	const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|mjs)$/.test(name) ? [path] : [];
	});
	const root = new URL("..", import.meta.url).pathname;
	const copies = [...files(join(root, "src")), ...files(join(root, "web/src"))]
		.filter((path) => /tool model calls|\(excludes |exclude compaction/.test(readFileSync(path, "utf8")));
	assert.deepEqual(copies, [], "only apps/trace-analytics/src/sources/spend.mjs spells the label words");
});

test("spend label: a total over updating Sessions is a lower bound that counts them", () => {
	const updating = { costUsd: 0, spend: unreadSpend(), updating: true as const };
	assert.equal(total([durable(0.75), updating, updating]), "≥ $0.75 · 2 updating", "the only gap is the unread Sessions");
	assert.equal(total([pi(0.75), updating]), "≥ $0.75 (excludes compaction, tool model calls) · 1 updating");
	assert.equal(total([pi(0.75), durable(0.25), updating]), "≥ $1.00 (some Sessions exclude compaction, tool model calls) · 1 updating");
	assert.equal(total([updating]), "≥ $0 · 1 updating");
	assert.equal(total([durable(null), updating]), "no price reported · 1 updating");
	const day = (over: object) => ({ id: "pi:x", title: "", cwd: "", createdAt: 0, updatedAt: 2, kind: "thread", activity: "idle", queued: 0, costUsd: 0.75, spend: historySpend(0.75), ...over }) as never;
	assert.deepEqual(activeSpend([day({}), day(updating), day({ updatedAt: 0 })], 1), { label: "≥ $0.75 (excludes compaction, tool model calls) · 1 updating", updating: 1 });
});
