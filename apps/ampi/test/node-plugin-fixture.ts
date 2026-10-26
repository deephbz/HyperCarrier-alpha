import type { Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

// Synthetic Pi Messages fixture. Existing provider markers must be replaced, including automatic caching.
export const piPayload = {
	model: "recording-model", max_tokens: 1000, stream: true,
	cache_control: { type: "ephemeral" },
	tools: [{ name: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
	system: [{ type: "text", text: "You are an expert coding assistant operating inside pi.\n\n<tools>\n- read: Read\n</tools>\n\n<rules>\n- Be concise\n</rules>\n\n<skills>\n- s\n</skills>\n\n<cwd>\n/work/example\n</cwd>", cache_control: { type: "ephemeral" } }],
	messages: [
		{ role: "user", content: [{ type: "text", text: "Read the file", cache_control: { type: "ephemeral" } }] },
		{ role: "assistant", content: [{ type: "text", text: "Read complete" }] },
		{ role: "system", content: [{ type: "text", text: "Updated project rules" }] },
		{ role: "user", content: [{ type: "text", text: "Continue", cache_control: { type: "ephemeral" } }] },
	],
};

export function recordingModels(payload: unknown = piPayload) {
	const calls: { sessionId?: string; payload: unknown; context: TranscriptContext }[] = [];
	const model: Model<"anthropic-messages"> = {
		id: "recording-model", name: "Recording", provider: "recording", api: "anthropic-messages",
		baseUrl: "http://localhost:0", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096,
	};
	const stream = (selected: Model<"anthropic-messages">, context: TranscriptContext, options?: SimpleStreamOptions) => {
		const events = createAssistantMessageEventStream();
		void (async () => {
			try {
				const raw = structuredClone(payload);
				const marked = (await options?.onPayload?.(raw, selected)) ?? raw;
				calls.push({ sessionId: options?.sessionId, payload: marked, context });
				const message = { ...fauxAssistantMessage("Recorded"), api: selected.api, provider: selected.provider, model: selected.id };
				events.push({ type: "done", reason: "stop", message });
				events.end(message);
			} catch (error) {
				const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: String(error) });
				events.push({ type: "error", reason: "error", error: message });
				events.end(message);
			}
		})();
		return events;
	};
	const models = createModels();
	models.setProvider(createProvider({
		id: "recording", auth: { apiKey: { name: "Recording", resolve: async () => ({ auth: {} }) } },
		models: [model], api: { stream, streamSimple: stream },
	}));
	return { models, model, calls };
}
