// Model access for one node: pi-ai's built-in providers with Pi's models.json layer (custom providers and overrides)
// and credentials shared with pi (auth.json and the usual environment variables), plus the offline ampi-sim provider.
// The node home's own models.json, when present, layers over Pi's for this node only.

import type { CredentialStore } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { join } from "node:path";
import { FileCredentialStore } from "./credentials.ts";
import { layerModelsJson, readModelsJson, withModelsJson } from "./models-json.ts";
import { piAgentDir, type PiSettings } from "./pi-config.ts";
import { SIM_MODEL, SIM_PROVIDER, simProvider } from "./sim.ts";
import { assertTestIsolation, isTestMode } from "./test-mode.ts";

export type ModelChoice = {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	available: boolean;
	/** The model new threads on this host start with. */
	default?: true;
};

const stores = new WeakMap<MutableModels, CredentialStore>();
const configErrors = new WeakMap<MutableModels, string[]>();

/** models.json errors from openModels: each names the provider whose layer was skipped. */
export function modelsJsonErrors(models: MutableModels): string[] {
	return configErrors.get(models) ?? [];
}

/** The credential store behind models made by openModels (pi's auth.json). */
export function credentialsOf(models: MutableModels): CredentialStore | undefined {
	return stores.get(models);
}

export function openModels(
	options: { agentDir?: string; authPath?: string; home?: string; sim?: { tokensPerSecond?: number; contextWindow?: number } } = {},
) {
	assertTestIsolation();
	const agentDir = options.agentDir ?? piAgentDir();
	const credentials = new FileCredentialStore(options.authPath ?? join(agentDir, "auth.json"));
	const models: MutableModels = createModels({ credentials });
	stores.set(models, credentials);
	const piModels = readModelsJson(agentDir);
	const { providers, errors } = withModelsJson(builtinProviders(), options.home ? layerModelsJson(piModels, readModelsJson(options.home)) : piModels);
	configErrors.set(models, errors);
	for (const provider of providers) models.setProvider(provider);
	models.setProvider(simProvider(options.sim));
	return models;
}

/** Restrict every node inference entry point before provider code or auth runs. Allowances belong to one node. */
export function testSafeModels(inner: MutableModels, testProviders: readonly string[] = []): MutableModels {
	if (!isTestMode()) return inner;
	const allowed = new Set([SIM_PROVIDER, ...testProviders]);
	const permits = (model: { provider: string; baseUrl?: string }): boolean => {
		if (!allowed.has(model.provider)) return false;
		// An empty URL declares an in-memory transport. Network fixtures must name an exact loopback host.
		if (!model.baseUrl) return true;
		try {
			const url = new URL(model.baseUrl);
			return ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
		} catch { return false; }
	};
	const requests = new Set<keyof MutableModels>([
		"stream", "complete", "streamSimple", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred", "generateImages", "classify",
	]);
	const guarded = new Proxy(inner, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (requests.has(key as keyof MutableModels)) return (model: { provider: string; baseUrl?: string }, ...args: unknown[]) => {
				if (!permits(model)) throw new Error(`AmPi test provider refused: ${model.provider}. Use ampi-sim or a scoped testProviders allowance with in-memory or loopback transport.`);
				return value.call(target, model, ...args);
			};
			// Inherited credential environment must not select a real default model for an otherwise offline test.
			if (key === "getAvailable") return async (...args: unknown[]) => (await value.apply(target, args)).filter(permits);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const credentials = stores.get(inner), errors = configErrors.get(inner);
	if (credentials) stores.set(guarded, credentials);
	if (errors) configErrors.set(guarded, errors);
	return guarded;
}

export async function listModels(models: MutableModels): Promise<ModelChoice[]> {
	const available = new Set<string>();
	try {
		for (const model of await models.getAvailable()) available.add(`${model.provider}/${model.id}`);
	} catch {}
	available.add(`${SIM_PROVIDER}/${SIM_MODEL}`);
	const choices: ModelChoice[] = [];
	for (const model of models.getModels()) {
		const key = `${model.provider}/${model.id}`;
		if (!available.has(key)) continue;
		choices.push({
			provider: model.provider,
			id: model.id,
			name: model.name ?? model.id,
			reasoning: model.reasoning === true,
			contextWindow: model.contextWindow ?? 0,
			available: true,
		});
	}
	return choices;
}

export type ModelStart = { provider: string; modelId: string; thinkingLevel: string };

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function globRegExp(pattern: string): RegExp {
	return new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

/** An `enabledModels` entry: `provider/id`, `id`, or a glob of either, with an optional `:thinking` suffix. */
function matchPattern(entry: string, choices: ModelChoice[]): { choice: ModelChoice; thinking?: string } | undefined {
	const colon = entry.lastIndexOf(":");
	const suffix = colon > 0 ? entry.slice(colon + 1) : undefined;
	const thinking = suffix && THINKING.includes(suffix) ? suffix : undefined;
	const pattern = thinking ? entry.slice(0, colon) : entry;
	const test = /[*?[]/.test(pattern) ? globRegExp(pattern) : undefined;
	const choice = choices.find((m) => {
		const ref = `${m.provider}/${m.id}`;
		return test ? test.test(ref) || test.test(m.id) : ref === pattern || m.id === pattern;
	});
	return choice ? { choice, ...(thinking ? { thinking } : {}) } : undefined;
}

/**
 * The model and thinking level new threads start with, in Pi's startup order (findInitialModel): the first available
 * `enabledModels` match, then `defaultProvider`/`defaultModel` when its provider has auth, then AMPI_MODEL, then the
 * newest available frontier model, then the sim. Thinking: the entry's suffix, `modelThinkingLevels`, then
 * `defaultThinkingLevel`, then Pi's `medium`; `off` for a model without reasoning.
 */
export async function startModel(models: MutableModels, settings: PiSettings = {}): Promise<ModelStart> {
	const choices = (await listModels(models)).filter((m) => m.provider !== SIM_PROVIDER || settings.defaultProvider === SIM_PROVIDER);
	const thinkingFor = (choice: ModelChoice | undefined, ref: string, explicit?: string) => {
		if (choice && !choice.reasoning) return "off";
		const perModel = settings.modelThinkingLevels?.[ref];
		const level = explicit ?? (typeof perModel === "string" ? perModel : undefined) ?? settings.defaultThinkingLevel;
		return typeof level === "string" && THINKING.includes(level) ? level : "medium";
	};
	const start = (choice: ModelChoice, explicit?: string): ModelStart => ({
		provider: choice.provider,
		modelId: choice.id,
		thinkingLevel: thinkingFor(choice, `${choice.provider}/${choice.id}`, explicit),
	});
	if (Array.isArray(settings.enabledModels))
		for (const entry of settings.enabledModels) {
			const found = typeof entry === "string" ? matchPattern(entry, choices) : undefined;
			if (found) return start(found.choice, found.thinking);
		}
	if (typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string") {
		const found = choices.find((m) => m.provider === settings.defaultProvider && m.id === settings.defaultModel);
		if (found) return start(found);
	}
	const configured = process.env.AMPI_MODEL;
	if (configured?.includes("/")) {
		const [provider, ...rest] = configured.split("/");
		const modelId = rest.join("/");
		const choice = choices.find((m) => m.provider === provider && m.id === modelId);
		return { provider: provider!, modelId, thinkingLevel: thinkingFor(choice, configured) };
	}
	const newest = (provider: string, family: RegExp) =>
		choices
			.filter((m) => m.provider === provider && family.test(m.id) && !/\d{8}/.test(m.id))
			.sort((a, b) => version(b.id) - version(a.id))[0];
	const preferred =
		newest("anthropic", /opus/) ??
		newest("anthropic", /sonnet/) ??
		newest("openai-codex", /^gpt-\d.*sol$|^gpt-\d[\d.]*$/) ??
		newest("openai", /^gpt-\d.*sol$|^gpt-\d[\d.]*$/) ??
		choices.find((m) => m.provider !== SIM_PROVIDER);
	if (preferred) return start(preferred);
	return { provider: SIM_PROVIDER, modelId: SIM_MODEL, thinkingLevel: "off" };
}

/** The default model for new threads; see startModel. */
export async function defaultModel(models: MutableModels, settings: PiSettings = {}): Promise<{ provider: string; modelId: string }> {
	const { provider, modelId } = await startModel(models, settings);
	return { provider, modelId };
}

/** "claude-opus-5-5" → 5.05, "gpt-6.1-sol" → 6.01: newer generations sort higher. */
export function version(id: string): number {
	const parts = (id.match(/\d+/g) ?? []).map(Number).filter((n) => n < 1000);
	return (parts[0] ?? 0) + (parts[1] ?? 0) / 100;
}
