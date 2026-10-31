import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadSummary } from "../src/shared/protocol.ts";
import { displayCwd, hudView } from "../web/src/hud.ts";

const text = (line: { text: string }[]) => line.map((s) => s.text).join("");
const summary = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
	id: "s1", title: "billing", cwd: "/workspace/billing", createdAt: 0, updatedAt: 0, kind: "thread",
	activity: "idle", queued: 0, costUsd: 1.234, model: "anthropic/claude-fable-5-1", contextTokens: 133_100, cacheHit: 97.8, ...over,
});

test("the card shows the Session's place and usage; the transcript header names the Session", () => {
	const view = hudView(summary());
	assert.deepEqual(view.lines.map(text), ["/workspace/billing", "133k/— ⟲— · $1.23 CH97%"]);
	assert.ok(!("gaps" in view), "the card lists no hub gaps");
	assert.ok(!view.lines.flat().some((span) => span.text === "billing"), "the card has no title span");
	assert.equal(displayCwd("/root/repos/billing"), "~/repos/billing");
	const windowed = hudView(summary({ contextWindow: 200_000, team: { teamId: "t", role: "worker" } }));
	assert.deepEqual(windowed.lines.map(text), ["/workspace/billing · t/worker", "67%/200k ⟲— · $1.23 CH97%"]);
	// With Auto Compact's working budget the ratio matches hc-hud's context.budget slot.
	const budgeted = hudView(summary({ contextTokens: 18_000, contextWindow: 1_000_000, workingBudget: 200_000 }));
	assert.equal(text(budgeted.lines[1]!), "9%/200k ⟲— · $1.23 CH97%");
	// A Session in a Herdr pane runs under a multiplexer, where hc-hud hides the Team slot.
	assert.equal(text(hudView(summary({ team: { teamId: "t", role: "worker" }, location: { pane: "p1" } })).lines[0]!), "/workspace/billing");
	// A Session without a cwd or a Team draws no empty row.
	assert.deepEqual(hudView(summary({ cwd: "" })).lines.map(text), ["133k/— ⟲— · $1.23 CH97%"]);
});

test("the Model ID is the full model string with its provider or route prefix", () => {
	for (const model of ["magpie/claude/claude-opus-5-5", "anthropic/claude-opus-5-5"]) {
		const view = hudView(summary({ model }));
		assert.equal(view.modelId, model);
		assert.ok(!view.lines.some((line) => text(line).includes("opus")), "the usage line carries no model alias");
	}
	assert.equal(hudView(summary({ model: undefined })).modelId, undefined);
});
