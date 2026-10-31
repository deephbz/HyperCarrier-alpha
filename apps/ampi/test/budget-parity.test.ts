import "./bound.ts";
import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compactTrigger, contextTokensOf, workingBudget } from "@hypercarrier/auto-compact-durable/budget";
// @ts-expect-error: Pi Auto Compact is plain ESM without types
import { utilizationAtOrAboveThreshold } from "../../../packages/hc-auto-compact/src/controller.mjs";
import { AgentDoc } from "@earendil-works/pi-durable";
import { resolveAutoCompactSettings } from "@hypercarrier/hc-auto-compact/resolve";
import { type CompactSettingsPort, compactSettingsPort, resolveCompactSettings } from "../src/node/compact-settings.ts";
import { fileStamp, piResources, piSettings } from "../src/node/pi-config.ts";
import type { NodeRuntime, Store } from "../src/node/runtime.ts";
import { modelLimits } from "../src/pi/host.ts";
import { budgetOptions, compactPlugin } from "../src/plugins/compact.ts";
import type { ThreadSummary } from "../src/shared/protocol.ts";
import { writePiSettings } from "./helpers.ts";

// K2.I1 checkpoint: for the same owner settings, a Pi Session and a durable thread show the same W, the same
// context figure, and ask for compaction at the same context size. Both carriers read Pi's settings.json
// `auto_compact`: threshold, budget_tokens, and a per-model budget_tokens.
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

// One corpus of global and project settings objects, valid and invalid.
const CORPUS: [global: Record<string, unknown>, project: Record<string, unknown>][] = [
	[{}, {}],
	[{ auto_compact: { budget_tokens: 200_000 } }, {}],
	[{ auto_compact: { budget_tokens: 200_000, threshold: 75, modelOverrides: { [MODEL]: { budget_tokens: 400_000 } } } }, {}],
	[{ auto_compact: { budget_tokens: 300_000, enabled: false, method: "summary" } }, { auto_compact: { enabled: true } }],
	[{ auto_compact: { modelOverrides: { [MODEL]: { budget_tokens: 1 }, "prov/small": { budget_tokens: 2 } } } }, { auto_compact: { modelOverrides: { [MODEL]: { budget_tokens: 3 } } } }],
	[{ auto_compact: { budget_tokens: -1, threshold: 200, method: "fast", enabled: "yes", modelOverrides: { [MODEL]: { budget_tokens: 1.5 }, "prov/small": {} } } }, {}],
	[{ auto_compact: { execution: "background", method: "native", preservation: "all" } }, {}],
	[{ auto_compact: "on" }, { auto_compact: { threshold: 1 } }],
	[{ compaction: { keepRecentTokens: 300, modelOverrides: { [MODEL]: { keepRecentTokens: 100 } } } }, {}],
	[{ compaction: { keepRecentTokens: -5, modelOverrides: { [MODEL]: { keepRecentTokens: "many" } } } }, {}],
];

test("budget parity: the durable settings are hc-auto-compact's resolution of the same files", () => {
	for (const [global, project] of CORPUS) {
		const label = JSON.stringify([global, project]);
		const pi = resolveAutoCompactSettings(global, project);
		const durable = resolveCompactSettings(global, project);
		assert.deepEqual(
			{ enabled: durable.enabled, method: durable.method, threshold: durable.thresholdPercent, budget: durable.budgetTokens, models: durable.modelBudgets },
			{ enabled: pi.settings.enabled, method: pi.settings.method, threshold: pi.settings.threshold, budget: pi.settings.budget_tokens,
				models: Object.fromEntries(Object.entries(pi.settings.modelOverrides ?? {}).map(([k, v]) => [k, v.budget_tokens])) },
			label,
		);
		// The durable errors are Pi's, then the keep-recent errors of the one mapping AmPi owns.
		assert.deepEqual(durable.errors.slice(0, pi.errors.length), pi.errors, label);
		assert.ok(durable.errors.slice(pi.errors.length).every((e) => e.startsWith("compaction.")), label);
	}
});

test("budget parity: one settings.json gives a durable thread and a Pi Session the same W, and an edit changes both", () => {
	const cwd = process.env.HOME!;
	const windows: Record<string, number> = { [MODEL]: 1_000_000, "prov/small": 128_000 };
	const port = compactSettingsPort();
	try {
		for (const [settings] of CORPUS) {
			writePiSettings(settings);
			assert.deepEqual(piSettings(cwd), piResources(cwd).settings, "the settings-only reader merges as the resource reader does");
			const durable = port.forCwd(cwd);
			assert.equal(port.stamp(cwd), durable.stamp, "the stat stamp is the stamp of the parsed settings");
			assert.equal(port.stamp(), port.global().stamp);
			assert.deepEqual({ ...port.global(), stamp: "" }, { ...durable, stamp: "" }, "an untrusted cwd reads the global settings");
			const pi = resolveAutoCompactSettings(settings).settings;
			// The Pi Session meter: the agent's `limits` budget from the same file, read by the host.
			const budget = settings.auto_compact ? { tokens: pi.budget_tokens, models: Object.fromEntries(Object.entries(pi.modelOverrides ?? {}).map(([k, v]) => [k, v.budget_tokens])) } : null;
			for (const model of Object.keys(windows)) {
				const session = modelLimits(model, { windows, budget });
				assert.equal(workingBudget(windows[model]!, budgetOptions(durable, model)), session.workingBudget ?? session.contextWindow, `W of ${model} for ${JSON.stringify(settings)}`);
			}
		}
		writePiSettings({ auto_compact: { budget_tokens: 200_000 } });
		assert.equal(workingBudget(1_000_000, budgetOptions(port.forCwd(cwd), MODEL)), 200_000);
		const before = port.global().stamp;
		writePiSettings({ auto_compact: { budget_tokens: 250_000 } });
		assert.notEqual(port.global().stamp, before, "an edit moves the stamp");
		assert.equal(workingBudget(1_000_000, budgetOptions(port.forCwd(cwd), MODEL)), 250_000, "an edit shows at the next read");
	} finally {
		writePiSettings(undefined);
	}
});

test("budget parity: a same-size edit inside one file-clock tick moves the stamp", () => {
	// A coarse file clock (a Linux kernel tick) gives both writes one mtime; utimes pins it so every OS shows that case.
	const file = join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
	const port = compactSettingsPort();
	const tick = (Date.now() - 1) / 1000;
	try {
		writePiSettings({ auto_compact: { budget_tokens: 200_000 } });
		utimesSync(file, tick, tick);
		const before = port.global().stamp;
		assert.equal(fileStamp(file), fileStamp(file), "a racy stamp is stable while the file is unchanged");
		writePiSettings({ auto_compact: { budget_tokens: 250_000 } });
		utimesSync(file, tick, tick);
		assert.notEqual(port.stamp(), before, "an edit moves the stamp");
		assert.equal(workingBudget(1_000_000, budgetOptions(port.global(), MODEL)), 250_000, "the edit shows at the next read");
		writeFileSync(file, JSON.stringify({ auto_compact: { budget_tokens: 250_000 } }));
		utimesSync(file, tick - 10, tick - 10);
		assert.doesNotMatch(fileStamp(file), /:.*:/, "a file older than the racy window costs one stat: its stamp is mtime:size");
	} finally {
		writePiSettings(undefined);
	}
});

test("budget parity: each Auto Compact plugin instance reads its own port", async () => {
	const fixed = (budget: number, keep: number, extra: Record<string, unknown> = {}): CompactSettingsPort => {
		const settings = resolveCompactSettings({ auto_compact: { budget_tokens: budget, ...extra }, compaction: { keepRecentTokens: keep } }, {}, `s${budget}`);
		return { global: () => settings, forCwd: () => settings, stamp: () => settings.stamp, file: () => "/pi/settings.json" };
	};
	const a = compactPlugin(fixed(20_000, 300)), b = compactPlugin(fixed(30_000, 400, { threshold: 500 }));
	const agent = { cwd: "/work", model: { provider: "prov", modelId: "m" } };
	const store = { harness: { snapshot: async (doc: unknown) => (doc === AgentDoc ? agent : undefined) } } as unknown as Store;
	const runtime = { models: { getModel: () => ({ contextWindow: 1_000_000 }) } } as unknown as NodeRuntime;
	const thread = { store, conversation: { id: 1 }, conversationId: "1" } as never;
	const summary = (): ThreadSummary => ({ cwd: "/work", model: MODEL, contextWindow: 1_000_000 }) as ThreadSummary;
	for (const [plugin, budget, keep] of [[a, 20_000, 300], [b, 30_000, 400]] as const) {
		const s = summary();
		await plugin.summarize!(store, "1", s);
		assert.equal(s.workingBudget, budget, "the meter");
		assert.equal((typeof plugin.settings === "function" ? plugin.settings({} as never) : plugin.settings)?.compaction?.keepRecentTokens, keep, "the harness keep-recent");
		assert.equal((await plugin.ops!["compact.records"]!({ threadId: "1" }, { ...runtime, thread: async () => thread } as never)).workingBudget, budget, "the records op");
		assert.match((await plugin.commands!["auto-compact"]!(runtime, thread, "status")).body!, new RegExp(`Working budget W: ${budget} tokens`), "the command");
	}
	assert.equal(a.nodeState!().settingsNotice, undefined);
	assert.deepEqual(b.nodeState!().settingsNotice, { stamp: "s30000", errors: ["auto_compact.threshold must be greater than 1 and less than 110"], file: "/pi/settings.json" });
	assert.notEqual(a.inputs!(), b.inputs!());
});

test("budget parity: the settings poll reads stamps only, so its cost does not grow with parsing", async () => {
	const settings = resolveCompactSettings({ auto_compact: { budget_tokens: 20_000 } }, {}, "s");
	let parses = 0;
	const parse = () => (parses++, settings);
	const plugin = compactPlugin({ global: parse, forCwd: parse, stamp: (cwd) => `s:${cwd ?? ""}`, file: () => "/pi/settings.json" });
	const store = { harness: { snapshot: async () => undefined } } as unknown as Store;
	for (let i = 0; i < 100; i++) await plugin.summarize!(store, String(i), { cwd: `/work/${i}`, model: MODEL } as ThreadSummary);
	parses = 0;
	assert.equal(plugin.inputs!().split("\n").length, 101, "the global stamp and one per seen cwd");
	assert.equal(parses, 0, "a poll parses no settings file");
});
