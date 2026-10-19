// Model access for one node: pi-ai's built-in providers with credentials shared with pi (auth.json and the usual
// environment variables), plus the offline ampi-sim provider.

import type { CredentialStore } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { FileCredentialStore } from "./credentials.ts";
import { SIM_MODEL, SIM_PROVIDER, simProvider } from "./sim.ts";

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

/** The credential store behind models made by openModels (pi's auth.json). */
export function credentialsOf(models: MutableModels): CredentialStore | undefined {
	return stores.get(models);
}

export function openModels(options: { authPath?: string; sim?: { tokensPerSecond?: number; contextWindow?: number } } = {}) {
	const credentials = new FileCredentialStore(options.authPath);
	const models: MutableModels = createModels({ credentials });
	stores.set(models, credentials);
	for (const provider of builtinProviders()) models.setProvider(provider);
	models.setProvider(simProvider(options.sim));
	return models;
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

/** The default model for new threads: AMPI_MODEL, else the first available non-sim model, else the sim. */
export async function defaultModel(models: MutableModels): Promise<{ provider: string; modelId: string }> {
	const configured = process.env.AMPI_MODEL;
	if (configured?.includes("/")) {
		const [provider, ...rest] = configured.split("/");
		return { provider: provider!, modelId: rest.join("/") };
	}
	const choices = await listModels(models);
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
	if (preferred) return { provider: preferred.provider, modelId: preferred.id };
	return { provider: SIM_PROVIDER, modelId: SIM_MODEL };
}

/** "claude-opus-5-5" → 5.05, "gpt-6.1-sol" → 6.01: newer generations sort higher. */
export function version(id: string): number {
	const parts = (id.match(/\d+/g) ?? []).map(Number).filter((n) => n < 1000);
	return (parts[0] ?? 0) + (parts[1] ?? 0) / 100;
}
