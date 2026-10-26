import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactTrigger, contextTokensOf, workingBudget } from "@hypercarrier/auto-compact-durable/budget";
// @ts-expect-error: Pi Auto Compact is plain ESM without types
import { utilizationAtOrAboveThreshold } from "../../../packages/hc-auto-compact/src/controller.mjs";
import { modelLimits } from "../src/pi/host.ts";

// K2.I1 checkpoint: for the same owner settings, a Pi Session and a durable thread show the same W, the same
// context figure, and ask for compaction at the same context size. Pi settings and the node's environment name
// the same three numbers: threshold (AMPI_COMPACT_THRESHOLD), budget_tokens (AMPI_WORKING_BUDGET), and a
// per-model budget_tokens.
const MODEL = "prov/m";
const cases = [
	{ window: 1_000_000, threshold: 90 },
	{ window: 1_000_000, threshold: 90, budget: 200_000 },
	{ window: 128_000, threshold: 80, budget: 200_000 },
	{ window: 1_000_000, threshold: 75, budget: 200_000, model: 400_000 },
	{ window: 64_000, threshold: 90, budget: 2_500 },
	{ window: 200_000, threshold: 33, budget: 100_001 },
];

test("budget parity: W and the compaction trigger match Pi's Auto Compact for the same settings", () => {
	for (const c of cases) {
		const pi = modelLimits(MODEL, { windows: { [MODEL]: c.window }, budget: { tokens: c.budget, ...(c.model ? { models: { [MODEL]: c.model } } : {}) } });
		const options = { thresholdPercent: c.threshold, budgetTokens: c.budget, modelBudgetTokens: c.model };
		const w = workingBudget(c.window, options);
		assert.equal(w, pi.workingBudget, `W for ${JSON.stringify(c)}`);
		// Pi asks when tokens / W reaches the threshold; durable asks at compactTrigger. The first crossing is the same token.
		const trigger = compactTrigger(c.window, options);
		const crossed = (tokens: number): boolean => utilizationAtOrAboveThreshold({ tokens, contextWindow: w }, c.threshold).crossed;
		assert.equal(crossed(trigger), true, `Pi crosses at the durable trigger for ${JSON.stringify(c)}`);
		assert.equal(crossed(trigger - 1), false, `Pi does not cross one token earlier for ${JSON.stringify(c)}`);
	}
});

test("budget parity: without Auto Compact settings both carriers measure against the window", () => {
	const pi = modelLimits(MODEL, { windows: { [MODEL]: 1_000_000 }, budget: null });
	// The HUD divides by `workingBudget ?? contextWindow`.
	assert.equal(pi.workingBudget ?? pi.contextWindow, workingBudget(1_000_000, {}));
});

test("budget parity: the context figure counts the last response's input, output and cache tokens on both carriers", () => {
	const usage = { input: 1_200, output: 300, cacheRead: 40_000, cacheWrite: 500 };
	assert.equal(contextTokensOf(usage), 42_000);
	assert.equal(contextTokensOf({ input: 10, output: null, cacheRead: undefined, cacheWrite: -1 }), 10, "missing or invalid parts count zero");
});
