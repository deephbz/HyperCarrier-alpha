import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error hc-hud ships JavaScript without declarations; the test compares against its source rule.
import { aliasName as hudAlias } from "../../../packages/hc-hud/src/visual-language.mjs";
import type { ThreadSummary } from "../src/shared/protocol.ts";
import { aliasName, displayCwd, hudView } from "../web/src/hud.ts";

const text = (line: { text: string }[]) => line.map((s) => s.text).join("");
const summary = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
	id: "s1", title: "billing", cwd: "/workspace/billing", createdAt: 0, updatedAt: 0, kind: "thread",
	activity: "idle", queued: 0, costUsd: 1.234, model: "anthropic/claude-fable-5-1", contextTokens: 133_100, cacheHit: 97.8, ...over,
});

test("the model alias follows hc-hud's default rule", () => {
	for (const model of ["anthropic/claude-fable-5-1", "openai/gpt-5.5", "magpie/claude/claude-opus-5-5"]) {
		const [provider, ...id] = model.split("/");
		assert.equal(aliasName(model), hudAlias({ provider, id: id.join("/") }));
	}
});

test("the full tier shows hub values and lists what the hub cannot see", () => {
	const view = hudView(summary());
	assert.deepEqual(view.lines.map(text), ["billing · /workspace/billing", "anthropic/fable5.1 · 133k/— ⟲— · $1.23 CH97%"]);
	assert.equal(displayCwd("/root/repos/billing"), "~/repos/billing");
	assert.equal(view.modelId, "anthropic/claude-fable-5-1");
	assert.ok(view.gaps.includes("context window") && view.gaps.includes("Auto Compact budget"));
	const windowed = hudView(summary({ contextWindow: 200_000, team: { teamId: "t", role: "worker" } }));
	assert.equal(text(windowed.lines[1]!), "anthropic/fable5.1 · 67%/200k ⟲— · $1.23 CH97%");
	assert.equal(text(windowed.lines[0]!), "billing · /workspace/billing · t/worker");
	assert.ok(!windowed.gaps.includes("context window"));
	// With Auto Compact's working budget the ratio matches hc-hud's context.budget slot; its threshold stays unknown.
	const budgeted = hudView(summary({ contextTokens: 18_000, contextWindow: 1_000_000, workingBudget: 200_000 }));
	assert.equal(text(budgeted.lines[1]!), "anthropic/fable5.1 · 9%/200k ⟲— · $1.23 CH97%");
	assert.ok(budgeted.gaps.includes("Auto Compact threshold and state") && !budgeted.gaps.includes("Auto Compact budget"));
	// A Session in a Herdr pane runs under a multiplexer, where hc-hud hides the Team slot.
	assert.equal(text(hudView(summary({ team: { teamId: "t", role: "worker" }, location: { pane: "p1" } })).lines[0]!), "billing · /workspace/billing");
});
