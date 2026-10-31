import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolveAutoCompactSettings } from "@hypercarrier/hc-auto-compact/resolve";
import { inlineModule } from "../src/pi/agent-modules.ts";
import { modelLimits } from "../src/pi/host.ts";
import { Agent, fixture, type Frame } from "./pi-fixtures.ts";

// The Pi Session meter's working budget W is hc-auto-compact's: the remote agent resolves settings.json through
// hc-auto-compact's resolver, and the host's modelLimits applies the budget rule of the controller's budgetFor.
const MODEL = "prov/m";
const WINDOWS: Record<string, number> = { [MODEL]: 1_000_000, "prov/small": 128_000, "prov/none": 64_000 };

/** W as hc-auto-compact's controller derives it (controller.mjs budgetFor, with no Session override). */
function autoCompactW(settings: Record<string, unknown>, model: string): number {
	const s = resolveAutoCompactSettings(settings).settings;
	return Math.min(s.modelOverrides?.[model]?.budget_tokens ?? s.budget_tokens ?? WINDOWS[model]!, WINDOWS[model]!);
}

// Global settings objects, valid and invalid. The agent reads the global file only.
const CORPUS: Record<string, unknown>[] = [
	{},
	{ auto_compact: { budget_tokens: 200_000 } },
	{ auto_compact: { budget_tokens: 200_000, threshold: 75, modelOverrides: { [MODEL]: { budget_tokens: 400_000 } } } },
	{ auto_compact: { budget_tokens: 300_000, enabled: false, method: "summary" } },
	{ auto_compact: { modelOverrides: { [MODEL]: { budget_tokens: 1 }, "prov/small": { budget_tokens: 2 } } } },
	{ auto_compact: { budget_tokens: -1, threshold: 200, method: "fast", enabled: "yes", modelOverrides: { [MODEL]: { budget_tokens: 1.5 }, "prov/small": {} } } },
	{ auto_compact: { budget_tokens: 2 ** 60, modelOverrides: { "prov/small": { budget_tokens: "many" }, "prov/none": null } } },
	{ auto_compact: { modelOverrides: [{ budget_tokens: 5 }] } },
	{ auto_compact: "on" },
	{ auto_compact: { budget_tokens: 500_000 } },
];

test("pi meter budget: the remote agent's limits give hc-auto-compact's W for every model and settings file", async (t) => {
	const f = fixture();
	writeFileSync(join(f.agentDir, "models.json"), "{}");
	const agent = Agent.start(f, { discoverMs: 40 });
	t.after(() => agent.stop());
	for (const [i, settings] of CORPUS.entries()) {
		// A window unique to this case marks the frame that reflects this edit.
		const marker = `prov/case-${i}`;
		writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify(settings));
		writeFileSync(join(f.agentDir, "models.json"), JSON.stringify({ providers: { prov: { modelOverrides: Object.fromEntries(
			Object.entries({ ...WINDOWS, [marker]: 1_000 }).map(([k, n]) => [k.slice("prov/".length), { contextWindow: n }])) } } }));
		const frame = await agent.wait((x: Frame) => x.t === "limits" && x.windows?.[marker] === 1_000, `limits for case ${i}`);
		for (const model of Object.keys(WINDOWS)) {
			const meter = modelLimits(model, { windows: frame.windows, budget: frame.budget ?? null });
			assert.equal(meter.workingBudget ?? meter.contextWindow, autoCompactW(settings, model), `W of ${model} for ${JSON.stringify(settings)}`);
		}
	}
});

test("pi meter budget: a shipped module inlines its relative imports and refuses bare ones", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-modules-"));
	writeFileSync(join(dir, "leaf.mjs"), "export const n = 7;\n");
	writeFileSync(join(dir, "root.mjs"), 'import { n } from "./leaf.mjs";\nexport const twice = n * 2;\n');
	writeFileSync(join(dir, "bare.mjs"), 'import { readFileSync } from "node:fs";\nexport { readFileSync };\n');
	assert.equal((await import(inlineModule(pathToFileURL(join(dir, "root.mjs")).href))).twice, 14);
	assert.throws(() => inlineModule(pathToFileURL(join(dir, "bare.mjs")).href), /cannot import node:fs/);
});
