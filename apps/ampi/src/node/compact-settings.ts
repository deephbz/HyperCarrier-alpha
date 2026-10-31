// Durable Auto Compact settings: Pi's settings.json (global, then the trusted project's) is their only source.
// hc-auto-compact's own resolver (packages/hc-auto-compact/src/resolve.mjs) gives the `auto_compact` keys their
// meaning, defaults and validation, so a durable thread and a Pi Session read one file the same way. hc-auto-compact
// has no keep-recent key and leaves it to Pi, so keep-recent is Pi's `compaction.keepRecentTokens` and its
// `compaction.modelOverrides` entry; that mapping is the only one this module owns.
// The Auto Compact plugin receives this port in hydrate(); it never reads settings files itself. Each call reads
// through the stamp cache, so an edit applies at the next read without a restart.

import type { CompactMethod } from "@hypercarrier/auto-compact-durable";
import { resolveAutoCompactSettings, settingsObject } from "@hypercarrier/hc-auto-compact/resolve";
import { type PiConfigOptions, type PiSettingsLayers, piSettingsFile, piSettingsLayers, piSettingsStamp } from "./pi-config.ts";

export type CompactSettings = {
	enabled: boolean;
	method: CompactMethod;
	/** The compaction trigger as a share of W, in percent. */
	thresholdPercent: number;
	/** W in tokens for every model; without it W is the context window. */
	budgetTokens?: number;
	/** W by `"provider/modelId"`, which wins over `budgetTokens`. */
	modelBudgets: Record<string, number>;
	/** Pi's `compaction.keepRecentTokens`; without it the node keeps its package default. */
	keepRecentTokens?: number;
	/** Pi's per-model keep-recent by `"provider/modelId"`. */
	modelKeepRecent: Record<string, number>;
	/** Invalid values that were ignored, in hc-auto-compact's words. */
	errors: string[];
	/** The stamp of the files these settings come from; it changes when they change. */
	stamp: string;
};

export type CompactSettingsPort = {
	/** The global settings: harness-wide values (keep-recent) and the node's settings notice read them. */
	global(): CompactSettings;
	/** The settings of a working directory: global, then its trusted project's. Without a cwd, the global settings. */
	forCwd(cwd?: string): CompactSettings;
	/** `forCwd(cwd).stamp` from `stat` calls only, with no parse: the cost of a poll stays one stat per file. */
	stamp(cwd?: string): string;
	/** The global settings file: the node's settings notice names it, so the owner knows where to fix it. */
	file(): string;
};

const nonNegative = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** The durable Auto Compact settings of Pi's global and project settings objects. */
export function resolveCompactSettings(global: Record<string, unknown>, project: Record<string, unknown> = {}, stamp = ""): CompactSettings {
	const { settings, errors, compaction } = resolveAutoCompactSettings(global, project);
	const result: CompactSettings = {
		enabled: settings.enabled,
		method: settings.method,
		thresholdPercent: settings.threshold,
		...(settings.budget_tokens !== undefined ? { budgetTokens: settings.budget_tokens } : {}),
		modelBudgets: Object.fromEntries(Object.entries(settings.modelOverrides ?? {}).map(([model, o]) => [model, o.budget_tokens])),
		modelKeepRecent: {},
		errors: [...errors],
		stamp,
	};
	if (compaction.keepRecentTokens !== undefined) {
		if (nonNegative(compaction.keepRecentTokens)) result.keepRecentTokens = compaction.keepRecentTokens;
		else result.errors.push("compaction.keepRecentTokens must be a non-negative integer");
	}
	for (const [model, override] of Object.entries(compaction.modelOverrides)) {
		const keep = settingsObject(override).keepRecentTokens;
		if (keep === undefined) continue;
		if (nonNegative(keep)) result.modelKeepRecent[model] = keep;
		else result.errors.push(`compaction.modelOverrides[${model}].keepRecentTokens must be a non-negative integer`);
	}
	return result;
}

/** The port over Pi's settings files. piSettingsLayers returns the same object until a file changes. */
export function compactSettingsPort(options: PiConfigOptions = {}): CompactSettingsPort {
	const resolved = new WeakMap<PiSettingsLayers, CompactSettings>();
	const read = (cwd?: string): CompactSettings => {
		const layers = piSettingsLayers(cwd, options);
		let result = resolved.get(layers);
		if (!result) resolved.set(layers, (result = resolveCompactSettings(layers.global, layers.project, layers.stamp)));
		return result;
	};
	return { global: () => read(), forCwd: read, stamp: (cwd?: string) => piSettingsStamp(cwd, options), file: () => piSettingsFile(options) };
}
