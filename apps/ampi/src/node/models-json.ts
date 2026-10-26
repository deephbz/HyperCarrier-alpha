// Pi's models.json layer for the node: custom providers and overrides of built-in providers, composed as Pi 1.4's
// provider-composer.js composes them without its extension layer. Values use Pi's config-value forms: a literal,
// `$NAME` / `${NAME}` environment references, or `!command` (stdout, cached for the process).
// Gap: per-model `headers` resolve when models are listed, and `!command` model headers are not run.
// A node home may add its own models.json in the same format (layerModelsJson). It changes this node's requests only;
// Pi's file stays the shared source.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isModelType, lazyStream, type ApiKeyAuth, type ModelAuth, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

// biome-ignore lint/suspicious/noExplicitAny: models.json entries are checked field by field, as in Pi.
type Json = Record<string, any>;
type AnyModel = ReturnType<Provider["getModels"]>[number];

const STREAMS: Record<string, () => ProviderStreams> = {
	"anthropic-messages": anthropicMessagesApi,
	"azure-openai-responses": azureOpenAIResponsesApi,
	"google-generative-ai": googleGenerativeAIApi,
	"mistral-conversations": mistralConversationsApi,
	"openai-codex-responses": openAICodexResponsesApi,
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
};
const streams = new Map<string, ProviderStreams>();

function streamsFor(api: string): ProviderStreams | undefined {
	if (!streams.has(api) && STREAMS[api]) streams.set(api, STREAMS[api]());
	return streams.get(api);
}

export type ModelsJson = { providers: Record<string, Json>; error?: string; path: string };

export function readModelsJson(agentDir: string): ModelsJson {
	const path = join(agentDir, "models.json");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { providers: {}, path };
	}
	try {
		const parsed = JSON.parse(text);
		const providers = parsed?.providers;
		return { providers: typeof providers === "object" && providers !== null && !Array.isArray(providers) ? providers : {}, path };
	} catch (error) {
		return { providers: {}, path, error: `${path}: ${(error as Error).message}` };
	}
}

/** Merge entries that share an `id`: the overlay's fields win, `headers` and `compat` merge, new ids append. */
function mergeById(base: unknown, overlay: unknown): Json[] | undefined {
	if (!Array.isArray(overlay)) return Array.isArray(base) ? base : undefined;
	const merged: Json[] = Array.isArray(base) ? [...base] : [];
	for (const entry of overlay) {
		const index = merged.findIndex((existing) => existing?.id === entry?.id);
		if (index < 0) merged.push(entry);
		else merged[index] = mergeEntry(merged[index]!, entry);
	}
	return merged;
}

function mergeEntry(base: Json, overlay: Json): Json {
	const merged: Json = { ...base, ...overlay };
	for (const key of ["headers", "compat"])
		if (typeof base[key] === "object" && typeof overlay[key] === "object") merged[key] = { ...base[key], ...overlay[key] };
	return merged;
}

/**
 * A node home's models.json over Pi's, provider by provider. Overlay fields replace Pi's; `models` merge by id;
 * `modelOverrides` merge by model id; `headers` and `compat` merge by key. A node can so move one model to another
 * api, base URL or header set and keep Pi's identity, auth, limits and thinking fields for it.
 */
export function layerModelsJson(base: ModelsJson, overlay: ModelsJson): ModelsJson {
	const providers: Record<string, Json> = { ...base.providers };
	for (const [id, config] of Object.entries(overlay.providers)) {
		const under = providers[id];
		if (typeof config !== "object" || config === null || typeof under !== "object" || under === null) {
			providers[id] = config;
			continue;
		}
		const merged = mergeEntry(under, config);
		const models = mergeById(under.models, config.models);
		if (models) merged.models = models;
		if (under.modelOverrides || config.modelOverrides) {
			merged.modelOverrides = { ...under.modelOverrides };
			for (const [modelId, override] of Object.entries(config.modelOverrides ?? {}))
				merged.modelOverrides[modelId] = merged.modelOverrides[modelId] ? mergeEntry(merged.modelOverrides[modelId], override as Json) : override;
		}
		providers[id] = merged;
	}
	const errors = [base.error, overlay.error].filter(Boolean);
	return { providers, path: overlay.path, ...(errors.length ? { error: errors.join("\n") } : {}) };
}

// --- Config values -------------------------------------------------------------------------------------------------

const commands = new Map<string, string | undefined>();

/** `$NAME` and `${NAME}` references; `$$` and `$!` escape. */
function envNames(value: string): string[] {
	if (value.startsWith("!")) return [];
	return [...value.matchAll(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*)|[$!])/g)].flatMap((m) => m[1] ?? m[2] ?? []);
}

function resolveValue(value: string, env: Record<string, string | undefined> = {}): string | undefined {
	if (value.startsWith("!")) {
		if (!commands.has(value)) {
			let out: string | undefined;
			try {
				out = execFileSync(process.env.SHELL || "/bin/sh", ["-c", value.slice(1)], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
			} catch {}
			commands.set(value, out);
		}
		return commands.get(value);
	}
	let missing = false;
	const resolved = value.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*)|([$!]))/g, (_, braced, bare, escaped) => {
		if (escaped) return escaped;
		const found = env[braced ?? bare] || process.env[braced ?? bare] || undefined;
		if (found === undefined) missing = true;
		return found ?? "";
	});
	return missing ? undefined : resolved;
}

function resolveHeaders(headers: Json | undefined, label: string): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [name, raw] of Object.entries(headers)) {
		if (typeof raw !== "string") continue;
		const value = resolveValue(raw);
		if (value === undefined) throw new Error(`Header ${name} for ${label} cannot be resolved`);
		out[name] = value;
	}
	return out;
}

// --- Models ----------------------------------------------------------------------------------------------------------

function mergeCompat(base: Json | undefined, override: Json | undefined): Json | undefined {
	if (!override) return base;
	const merged: Json = { ...base, ...override };
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"])
		if ((typeof base?.[key] === "object" && base[key] !== null) || (typeof override[key] === "object" && override[key] !== null))
			merged[key] = { ...base?.[key], ...override[key] };
	return merged;
}

function applyOverride(model: Json, override: Json): Json {
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap ? { ...model.thinkingLevelMap, ...override.thinkingLevelMap } : model.thinkingLevelMap,
		input: override.input ?? model.input,
		inputLimits: override.inputLimits ? { ...model.inputLimits, ...override.inputLimits } : model.inputLimits,
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost?.input,
					output: override.cost.output ?? model.cost?.output,
					cacheRead: override.cost.cacheRead ?? model.cost?.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost?.cacheWrite,
					tiers: override.cost.tiers ?? model.cost?.tiers,
				}
			: model.cost,
		promptCache: override.promptCache ? { ...model.promptCache, ...override.promptCache } : model.promptCache,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		samplingParams: override.samplingParams ? { ...model.samplingParams, ...override.samplingParams } : model.samplingParams,
		compat: mergeCompat(model.compat, override.compat),
	};
}

function modelFromJson(providerId: string, definition: Json, config: Json, defaults: Json | undefined): Json {
	const api = definition.api ?? config.api ?? defaults?.api;
	if (!api) throw new Error(`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`);
	const baseUrl = definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	if (definition.contextWindow !== undefined && definition.contextWindow <= 0) throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	if (definition.maxTokens !== undefined && definition.maxTokens <= 0) throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api,
		provider: providerId,
		baseUrl,
		reasoning: definition.reasoning ?? false,
		thinkingLevelMap: definition.thinkingLevelMap,
		input: definition.input ?? ["text"],
		inputLimits: definition.inputLimits,
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		promptCache: definition.promptCache,
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
		samplingParams: definition.samplingParams,
		samplingParamsByThinkingLevel: definition.samplingParamsByThinkingLevel,
		headers: undefined,
		compat: mergeCompat(config.compat, definition.compat),
	};
}

function applyModelsJson(providerId: string, baseModels: readonly Json[], config: Json): Json[] {
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	if (!config.models?.length && !config.baseUrl && !config.headers && !config.compat && !hasOverrides && !config.apiKey && config.authHeader === undefined)
		throw new Error(`Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`);
	const models: Json[] = baseModels.map((model) =>
		isModelType(model as AnyModel, "chat") ? { ...model, baseUrl: config.baseUrl ?? model.baseUrl, compat: mergeCompat(model.compat, config.compat) } : { ...model, baseUrl: config.baseUrl ?? model.baseUrl },
	);
	const chat = () => models.filter((model) => isModelType(model as AnyModel, "chat"));
	for (const definition of Array.isArray(config.models) ? config.models : []) {
		const index = models.findIndex((model) => isModelType(model as AnyModel, "chat") && model.id === definition.id);
		const api = definition.api ?? config.api;
		const defaults =
			chat().find((model) => model.id === definition.id) ??
			(api ? chat().find((model) => model.api === api) : undefined) ??
			chat().find((model) => model.api === "openai-completions") ??
			chat()[0];
		const model = modelFromJson(providerId, definition, config, defaults);
		if (index >= 0) models[index] = model;
		else models.push(model);
	}
	return models;
}

// --- Auth -------------------------------------------------------------------------------------------------------------

function withConfiguredAuth(auth: ModelAuth, headers: Record<string, string> | undefined, authHeader: boolean): ModelAuth {
	let merged = auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
	if (authHeader) {
		if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
		merged = { ...merged, Authorization: `Bearer ${auth.apiKey}` };
	}
	return { ...auth, ...(merged ? { headers: merged } : {}) };
}

function composeApiKeyAuth(providerId: string, base: Provider | undefined, config: Json): ApiKeyAuth | undefined {
	const inherited = base?.auth.apiKey;
	const rawKey: string | undefined = typeof config.apiKey === "string" ? config.apiKey : undefined;
	if (!inherited && rawKey === undefined && base?.auth.oauth) return undefined;
	const authHeader = config.authHeader === true;
	return {
		name: inherited?.name ?? "API key",
		login:
			inherited?.login ??
			(async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter API key" }) })),
		check: async (input) => {
			if (input.credential) {
				if (inherited?.check) return inherited.check(input);
				if (input.credential.key) return { type: "api_key", source: "stored credential" };
				const resolved = await inherited?.resolve(input);
				return resolved ? { type: "api_key", source: resolved.source } : undefined;
			}
			if (rawKey !== undefined) {
				for (const name of envNames(rawKey)) if ((await input.ctx.env(name)) === undefined) return undefined;
				return { type: "api_key", source: "configured API key" };
			}
			if (inherited?.check) return inherited.check(input);
			const resolved = await inherited?.resolve(input);
			return resolved ? { type: "api_key", source: resolved.source } : undefined;
		},
		resolve: async (input) => {
			let result: Awaited<ReturnType<ApiKeyAuth["resolve"]>>;
			if (input.credential) {
				result = inherited
					? await inherited.resolve(input)
					: input.credential.key
						? { auth: { apiKey: input.credential.key }, ...(input.credential.env ? { env: input.credential.env } : {}), source: "stored credential" }
						: undefined;
			} else if (rawKey !== undefined) {
				const env: Record<string, string | undefined> = {};
				for (const name of envNames(rawKey)) env[name] = await input.ctx.env(name);
				const key = resolveValue(rawKey, env);
				if (key === undefined) throw new Error(`API key for provider "${providerId}" cannot be resolved`);
				result = inherited ? await inherited.resolve({ ...input, credential: { type: "api_key", key } }) : { auth: { apiKey: key }, source: "configured API key" };
			} else result = await inherited?.resolve(input);
			if (!result) return undefined;
			return { ...result, auth: withConfiguredAuth(result.auth, resolveHeaders(config.headers, `provider "${providerId}"`), authHeader) };
		},
	};
}

// --- Providers --------------------------------------------------------------------------------------------------------

/** One provider with its models.json layer: `base` is the built-in provider of that id, if any. */
export function composeProvider(providerId: string, base: Provider | undefined, config: Json): Provider {
	const baseModels = base ? (base.getAllModels?.() ?? base.getModels()) : [];
	const getAllModels = () =>
		applyModelsJson(providerId, baseModels as unknown as Json[], config).map((model) => {
			const override = config.modelOverrides?.[model.id];
			let next = override && isModelType(model as AnyModel, "chat") ? applyOverride(model, override) : model;
			const headers = { ...override?.headers, ...(Array.isArray(config.models) ? config.models.find((entry: Json) => entry.id === model.id)?.headers : undefined) };
			if (Object.keys(headers).length > 0) next = { ...next, headers: { ...next.headers, ...resolveHeaders(headers, `model "${providerId}/${model.id}"`) } };
			return next;
		}) as unknown as AnyModel[];
	getAllModels();
	const apiKey = composeApiKeyAuth(providerId, base, config);
	const oauth = base?.auth.oauth;
	if (!apiKey && !oauth) throw new Error(`Provider ${providerId}: no authentication method configured.`);
	const baseApis = new Set(base?.getModels().map((model) => model.api));
	const streamWith = (model: AnyModel, context: never, options: never, simple: boolean) =>
		lazyStream(model, async () => {
			if (base && baseApis.has(model.api)) return simple ? base.streamSimple(model, context, options) : base.stream(model, context, options);
			const api = streamsFor(model.api);
			if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
			return simple ? api.streamSimple(model, context, options) : api.stream(model, context, options);
		});
	return {
		id: providerId,
		name: config.name ?? base?.name ?? providerId,
		...(config.baseUrl ?? base?.baseUrl ? { baseUrl: config.baseUrl ?? base?.baseUrl } : {}),
		...(base?.headers ? { headers: base.headers } : {}),
		auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		...(base?.refreshModels ? { refreshModels: (context) => base.refreshModels!(context) } : {}),
		...(base?.filterModels ? { filterModels: (models, credential) => base.filterModels!(models, credential) } : {}),
		stream: (model, context, options) => streamWith(model, context as never, options as never, false),
		streamSimple: (model, context, options) => streamWith(model, context as never, options as never, true),
	} as Provider;
}

/**
 * Apply models.json to the built-in providers. A provider that fails validation keeps its built-in form (or is
 * absent when custom), and its error joins `errors`, as Pi reports models.json errors without failing startup.
 */
export function withModelsJson(builtins: Provider[], modelsJson: ModelsJson): { providers: Provider[]; errors: string[] } {
	const errors = modelsJson.error ? [modelsJson.error] : [];
	const byId = new Map(builtins.map((provider) => [provider.id, provider]));
	for (const [id, config] of Object.entries(modelsJson.providers)) {
		if (typeof config !== "object" || config === null) continue;
		try {
			byId.set(id, composeProvider(id, byId.get(id), config));
		} catch (error) {
			errors.push((error as Error).message);
		}
	}
	return { providers: [...byId.values()], errors };
}
