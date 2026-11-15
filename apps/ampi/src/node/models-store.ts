// Pi's models-store.json layer for the node: the provider catalogs that Pi saves (`pi update --models`, a Pi start),
// restored over pi-ai's built-in providers as Pi 1.5's remote-catalog-provider.js restores them offline. Pi owns the
// file and its network refresh: the node only reads it. Pi does not export these rules, so they are repeated here:
// - openrouter: a saved, non-empty catalog replaces the built-in models (withPersonalizedCatalog);
// - radius: no catalog;
// - any other provider: a saved catalog newer than the built-in model data merges over it by model type and id
//   (withRemoteCatalog).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getModelType, isModelType, type Provider } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";

type AnyModel = ReturnType<NonNullable<Provider["getAllModels"]>>[number];
type StoreEntry = { models?: unknown; lastModified?: unknown };
export type ModelsStoreFile = { entries: Record<string, StoreEntry>; error?: string; path: string };

export const modelsStorePath = (agentDir: string) => join(agentDir, "models-store.json");

export function readModelsStore(agentDir: string): ModelsStoreFile {
	const path = modelsStorePath(agentDir);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { entries: {}, path };
	}
	try {
		const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
		return { entries: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {}, path };
	} catch (error) {
		return { entries: {}, error: `${path}: ${(error as Error).message}`, path };
	}
}

function storedModels(providerId: string, entry: StoreEntry | undefined): AnyModel[] {
	if (!entry || !Array.isArray(entry.models)) return [];
	return entry.models.filter((m): m is AnyModel => typeof m === "object" && m !== null && typeof m.id === "string" && m.provider === providerId);
}

function withModels(provider: Provider, all: AnyModel[]): Provider {
	return { ...provider, getModels: () => all.filter((m) => isModelType(m, "chat")) as ReturnType<Provider["getModels"]>, getAllModels: () => all };
}

/** Built-in providers with their saved catalogs. A provider without a usable entry stays as pi-ai ships it. */
export function withModelsStore(builtins: Provider[], store: ModelsStoreFile): Provider[] {
	const generatedAt = getBuiltinModelDataGeneratedAt();
	return builtins.map((provider) => {
		if (provider.id === "radius") return provider;
		const entry = store.entries[provider.id];
		const saved = storedModels(provider.id, entry);
		if (saved.length === 0) return provider;
		if (provider.id === "openrouter") return withModels(provider, saved);
		const lastModified = typeof entry?.lastModified === "number" ? entry.lastModified : undefined;
		if (generatedAt !== undefined && (lastModified === undefined || lastModified <= generatedAt)) return provider;
		const merged = new Map<string, AnyModel>();
		for (const model of [...(provider.getAllModels?.() ?? provider.getModels()), ...saved]) merged.set(`${getModelType(model)}\0${model.id}`, model);
		return withModels(provider, [...merged.values()]);
	});
}
