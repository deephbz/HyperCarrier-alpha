// Request-local cache placement for the durable node. The node owns TTL persistence and lookup; no warmer runs here.
import type { Models } from "@earendil-works/pi-ai/models";
import type { Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";
import { type CapturedRequest, PLANNER_REQUEST, type PlannerMark } from "@hypercarrier/auto-compact-durable";
// @ts-expect-error Cache Goblin publishes JavaScript without declarations.
import { isAnthropicMessagesPayload, placeMarkers, stripMarkers } from "@hypercarrier/pi-cache-goblin/plan";
// @ts-expect-error Cache Goblin publishes JavaScript without declarations.
import { findGlobalBoundary } from "@hypercarrier/pi-cache-goblin/system-split";
// @ts-expect-error Cache Goblin publishes JavaScript without declarations.
import { defaultGlobalPaths } from "@hypercarrier/pi-cache-goblin";

export type CacheTtl = "5m" | "1h";
export const CacheTtlDoc = defineDoc<{ ttl: CacheTtl }>({
	kind: "ampi.cache", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ ttl: "5m" }), checkpointWhen: () => true,
});

/** The key is ProviderDoc.sessionId, not a thread or conversation ID. Unscoped calls have no key. */
export type CacheTtlLookup = (sessionId: string | undefined) => CacheTtl | Promise<CacheTtl>;

const LAST_REQUESTS = 16;
const lastRequests = new Map<string, CapturedRequest>();

/**
 * The last real request of a provider session (ProviderDoc.sessionId) in this process, for the keepset planner. The
 * planner sends it again with one appended user message, so the provider reads the whole prefix from its cache.
 */
export const lastRequest = (sessionId: string | undefined): CapturedRequest | undefined => (sessionId ? lastRequests.get(sessionId) : undefined);

// A conversation request carries durable's system message with prompt sections or tools; summaries and titles do not.
const isConversationRequest = (context: Context, options?: StreamOptions) =>
	!!options?.sessionId && context.messages.some((m) => (m.role as string) === "system" && ("sections" in m || "toolsAdded" in m));

function capture(model: Model<never>, context: Context, options: StreamOptions): CapturedRequest {
	const kept: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options)) if (typeof value !== "function" && key !== "signal") kept[key] = value;
	const captured: CapturedRequest = { model, context: { ...context, messages: [...context.messages] }, options: kept as StreamOptions, at: Date.now() };
	lastRequests.delete(options.sessionId!);
	lastRequests.set(options.sessionId!, captured);
	while (lastRequests.size > LAST_REQUESTS) lastRequests.delete(lastRequests.keys().next().value!);
	return captured;
}

export function cacheGoblinModels<T extends Models>(inner: T, ttlFor: CacheTtlLookup): T {
	const globalPaths = defaultGlobalPaths();
	const optionsFor = <O extends StreamOptions>(model: Model<never>, context: Context, options?: O): O => {
		// A keepset planning request reuses a captured request; it is not one itself.
		const planner = (options as { [PLANNER_REQUEST]?: PlannerMark } | undefined)?.[PLANNER_REQUEST];
		const captured = !planner && isConversationRequest(context, options) ? capture(model, context, options!) : undefined;
		return {
			...options,
			onPayload: async (payload: unknown, model: Parameters<NonNullable<StreamOptions["onPayload"]>>[1]) => {
				const transformed = (await options?.onPayload?.(payload, model)) ?? payload;
				if (model.api !== "anthropic-messages" || !isAnthropicMessagesPayload(transformed)) return transformed;
				const place = async (payload: unknown) => placeMarkers(payload, {
					sessionTtl: await ttlFor(options?.sessionId),
					globalBoundary: (text: string) => findGlobalBoundary(text, { globalPaths }),
				}).payload;
				const messages = (transformed as { messages: unknown[] }).messages;
				const prefix = planner?.prefixMessages;
				if (prefix !== undefined && prefix < messages.length) {
					// The planner's prefix gets the captured request's marks, byte for byte; the appended messages stay unmarked.
					const head = await place({ ...(transformed as object), messages: messages.slice(0, prefix) });
					return { ...head, messages: [...head.messages, ...stripMarkers({ messages: messages.slice(prefix) }).messages] };
				}
				const placed = await place(transformed);
				if (captured) captured.prefixMessages = placed.messages.length;
				return placed;
			},
		} as O;
	};
	const streams: Pick<Models, "stream" | "streamSimple" | "complete" | "completeSimple"> = {
		stream: (model, context, options) => inner.stream(model, context, optionsFor(model as never, context, options)),
		streamSimple: (model, context, options) => inner.streamSimple(model, context, optionsFor(model as never, context, options)),
		complete: (model, context, options) => inner.complete(model, context, optionsFor(model as never, context, options)),
		completeSimple: (model, context, options) => inner.completeSimple(model, context, optionsFor(model as never, context, options)),
	};
	// Bind every other method to its owner, including mutable catalogs and future Models methods.
	return new Proxy(inner, {
		get(target, key) {
			if (Object.hasOwn(streams, key)) return streams[key as keyof typeof streams];
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
