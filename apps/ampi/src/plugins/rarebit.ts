// Rarebit in the AmPi node. The selection is a pure projection of the durable history, so the node derives it on
// demand; only model-derived judgments (Summary, Title) are stored, as receipts in the conversation's RarebitDoc that
// name the evidence they cover. A Summary runs when a run settles with a stop (agent_settled, gated by the eligibility
// policy) or when the owner asks (manual). A crash mid-derivation leaves a `running` mark from an older boot, which
// the next refresh ignores and redoes: the derivation is idempotent over immutable evidence.

import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import {
	type Boundary,
	type Completion,
	DEFAULT_POLICY,
	deriveSummary,
	deriveTitle,
	RarebitDoc,
	type RarebitState,
	rarebitExtension,
	select,
	type SummaryPolicy,
} from "@hypercarrier/durable-rarebit";
import { contentText } from "../node/projection.ts";
import { MetaDoc, NodeError, type NodePlugin, type NodeRuntime, parseThreadKey, type Store } from "../node/runtime.ts";
import { ops, type TopicSource, topics } from "../node/server.ts";
import { defaultModel } from "../node/models.ts";

const BOOT = randomBytes(4).toString("hex");
const TEXT_LIMIT = 6_000;

function policy(): SummaryPolicy {
	const min = Number(process.env.AMPI_RAREBIT_MIN_TOKENS);
	const ratio = Number(process.env.AMPI_RAREBIT_MAX_RATIO);
	return {
		minTotalLength: Number.isFinite(min) && process.env.AMPI_RAREBIT_MIN_TOKENS ? min : DEFAULT_POLICY.minTotalLength,
		maxRarebitRatio: Number.isFinite(ratio) && process.env.AMPI_RAREBIT_MAX_RATIO ? ratio : DEFAULT_POLICY.maxRarebitRatio,
	};
}

/** Full fork-aware history of one conversation, ascending, read incrementally into a per-conversation cache. */
class History {
	entries: EntryRecord[] = [];
	#store: Store;
	#conversationId: string;
	constructor(store: Store, conversationId: string) {
		this.#store = store;
		this.#conversationId = conversationId;
	}
	#loading: Promise<EntryRecord[]> | undefined;
	/** Single-flight: concurrent readers share one incremental read, so no page is appended twice. */
	load(): Promise<EntryRecord[]> {
		this.#loading ??= this.#load().finally(() => {
			this.#loading = undefined;
		});
		return this.#loading;
	}
	async #load(): Promise<EntryRecord[]> {
		const conversation = await this.#store.conversation(this.#conversationId);
		for (;;) {
			const last = this.entries.at(-1);
			const page = await conversation.entries(
				{ order: "ascending", ...(last ? { minEntryId: (Number(last.id) + 1) as EntryId } : {}) },
				500,
				undefined,
				BACKGROUND_CONTEXT,
			);
			this.entries.push(...(page.items as EntryRecord[]));
			if (page.next === undefined || page.items.length === 0) break;
		}
		return this.entries;
	}
}

const histories = new WeakMap<Store, Map<string, History>>();
export function history(store: Store, conversationId: string): History {
	let byConv = histories.get(store);
	if (!byConv) histories.set(store, (byConv = new Map()));
	let found = byConv.get(conversationId);
	if (found) byConv.delete(conversationId);
	else found = new History(store, conversationId);
	// Most recently used last; a bounded cache, so long-lived nodes do not keep every transcript in memory.
	byConv.set(conversationId, found);
	if (byConv.size > 48) byConv.delete(byConv.keys().next().value!);
	return found;
}

/** The Rarebit view a client draws: occurrences interleaved with compaction and reset boundaries, plus receipts. */
function rarebitView(entries: readonly EntryRecord[], state: RarebitState | undefined): JsonValue {
	const { occurrences } = select(entries);
	const byId = new Map(occurrences.map((o) => [o.sourceEntryId, o]));
	let head: number | undefined;
	const items: JsonValue[] = [];
	for (const entry of entries) {
		const id = String(entry.id);
		if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") {
			if (entry.head !== undefined) head = Number(entry.head);
			// biome-ignore lint: loosely typed pi-ai message
			const message = entry.model?.[0] as any;
			items.push({
				kind: entry.kind === "pi.compaction" ? "compaction" : "reset",
				entryId: id,
				ts: message?.timestamp ?? null,
				text: contentText(message?.content).slice(0, 600),
			});
			continue;
		}
		const o = byId.get(id);
		if (!o) continue;
		items.push({
			kind: "rarebit",
			entryId: id,
			role: o.role,
			outcome: o.outcome,
			ts: o.timestamp,
			text: o.text.length > TEXT_LIMIT ? `${o.text.slice(0, TEXT_LIMIT)}…` : o.text,
			truncated: o.text.length > TEXT_LIMIT,
		});
	}
	// Evidence before the active context's head is no longer seen by the model; Rarebit still has it.
	if (head !== undefined) for (const item of items as { entryId: string; outOfContext?: boolean }[]) if (Number(item.entryId) < head) item.outOfContext = true;
	const last = occurrences.at(-1);
	return {
		items,
		count: occurrences.length,
		lastOccurrenceId: last?.sourceEntryId ?? null,
		state: (state ?? {}) as JsonValue,
		fresh: !!state?.summary && state.summary.coveredEntryId === last?.sourceEntryId,
		policy: policy(),
	} as JsonValue;
}

/** The runtime that owns each store (several runtimes can share a process, as tests do). */
const owners = new WeakMap<Store, NodeRuntime>();
const runtimes = new Set<NodeRuntime>();
export function runtimeOf(store: Store): NodeRuntime {
	const runtime = owners.get(store);
	if (!runtime) throw new Error(`storage ${store.id} is not attached`);
	return runtime;
}
export function storeById(id: string): Store {
	for (const runtime of runtimes) {
		const store = runtime.stores.get(id);
		if (store && !store.closed) return store;
	}
	throw new Error(`thread storage ${id} is unavailable on this node`);
}

export function rarebitPlugin(): NodePlugin {
	const jobs = new Map<string, Promise<void>>();

	async function complete(store: Store, conversationId: string, prompt: string): Promise<Completion> {
		const node = runtimeOf(store);
		const configured = process.env.AMPI_RAREBIT_MODEL;
		let ref: { provider: string; modelId: string } | undefined;
		if (configured?.includes("/")) {
			const [provider, ...rest] = configured.split("/");
			ref = { provider: provider!, modelId: rest.join("/") };
		}
		if (!ref) {
			const { AgentDoc } = await import("@earendil-works/pi-durable");
			const agent = await store.harness.snapshot(AgentDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
			ref = agent?.model ?? (await defaultModel(node.models));
		}
		const model = node.models.getModel(ref.provider, ref.modelId);
		if (!model) throw new Error(`No model ${ref.provider}/${ref.modelId}`);
		const message = await node.models.completeSimple(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{ maxTokens: 2048 },
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? `model ${message.stopReason}`);
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { text: string }).text)
			.join("");
		return { text, model: `${ref.provider}/${ref.modelId}`, costUsd: message.usage?.cost?.total };
	}

	async function change(store: Store, conversationId: string, fn: (state: RarebitState) => void): Promise<void> {
		await store.harness.commit(async (tx) => {
			fn(await tx.doc(RarebitDoc, Number(conversationId) as ConversationId));
		}, BACKGROUND_CONTEXT);
	}

	/** One Summary derivation at a time per conversation; `trigger` is the stop entry that asked for it. */
	function summarizeNow(store: Store, conversationId: string, boundary: Boundary, trigger: string): Promise<void> {
		const key = store.threadKey(conversationId);
		const running = jobs.get(key);
		if (running) return running;
		const job = (async () => {
			await change(store, conversationId, (s) => {
				s.running = { boundary, coveredEntryId: trigger, since: Date.now(), boot: BOOT };
			});
			try {
				const entries = await history(store, conversationId).load();
				const receipt = await deriveSummary({
					entries,
					boundary,
					policy: policy(),
					complete: (prompt) => complete(store, conversationId, prompt),
				});
				await change(store, conversationId, (s) => {
					delete s.running;
					s.trigger = trigger;
					if (!receipt) return;
					s.attempt = receipt;
					if (receipt.status === "summarized") s.summary = receipt;
				});
			} catch (error) {
				await change(store, conversationId, (s) => {
					delete s.running;
				}).catch(() => {});
				throw error;
			}
		})().finally(() => jobs.delete(key));
		jobs.set(key, job);
		return job;
	}

	function titleNow(store: Store, conversationId: string): void {
		const key = `title:${store.threadKey(conversationId)}`;
		if (jobs.has(key)) return;
		const job = (async () => {
			const entries = await history(store, conversationId).load();
			const title = await deriveTitle({ entries, complete: (prompt) => complete(store, conversationId, prompt) }).catch((error) => {
				runtimeOf(store).report(error);
				return undefined;
			});
			await change(store, conversationId, (s) => {
				s.title = title ?? { title: "", sourceEntryId: "", model: "", at: Date.now() };
			});
		})()
			.catch((error) => runtimeOf(store).report(error))
			.finally(() => jobs.delete(key));
		jobs.set(key, job);
	}

	ops.set("rarebit.summarize", async (args, runtime) => {
		const { store, conversation } = await runtime.thread(String(args.threadId));
		const entries = await history(store, String(conversation.id)).load();
		const last = select(entries).occurrences.at(-1);
		if (!last) throw new NodeError("bad_request", "This thread has no Rarebits yet.");
		await summarizeNow(store, String(conversation.id), "manual", last.sourceEntryId);
		return { ok: true };
	});

	topics.set("rarebit", async (topic, runtime) => {
		if (topic.kind !== "rarebit") throw new NodeError("bad_request", "rarebit topic");
		const { storeId, conversationId } = parseThreadKey(topic.threadId);
		const store = runtime.store(storeId);
		const id = Number(conversationId) as ConversationId;
		const read = async () => rarebitView(await history(store, conversationId).load(), await store.harness.snapshot(RarebitDoc, id, BACKGROUND_CONTEXT));
		let current = await read();
		const listeners = new Set<(value: JsonValue) => void>();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = store.harness.subscribeCommits((publication) => {
			const touched = publication.changes.some(
				(c) => (c.type === "entry" && String(c.value.conversationId) === conversationId) || (c.type === "document" && String(c.conversationId) === conversationId),
			);
			if (!touched || timer) return;
			timer = setTimeout(async () => {
				timer = undefined;
				try {
					current = await read();
					for (const listener of listeners) listener(current);
				} catch {}
			}, 150);
		});
		return {
			get value() {
				return current;
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			dispose() {
				stop();
				if (timer) clearTimeout(timer);
			},
		} satisfies TopicSource;
	});

	return {
		extensions: [
			rarebitExtension(async (api, context) => {
				const meta = await api.snapshot(MetaDoc, context);
				if (!meta?.store) throw new Error("Rarebit history is unavailable in this storage.");
				return history(storeById(meta.store), String(api.conversationId)).load();
			}),
		],
		attach(store, runtime) {
			owners.set(store, runtime);
			runtimes.add(runtime);
		},
		async summarize(store, conversationId, summary) {
			const id = Number(conversationId) as ConversationId;
			const state = await store.harness.snapshot(RarebitDoc, id, BACKGROUND_CONTEXT);
			const last = select(await history(store, conversationId).load()).occurrences.at(-1);
			if (state?.summary)
				summary.rarebit = {
					status: state.summary.sessionStatus,
					reason: state.summary.statusReason,
					asOf: state.summary.at,
					fresh: state.summary.coveredEntryId === last?.sourceEntryId,
				};
			else if (state?.attempt?.status === "error") summary.rarebit = { status: "error", reason: state.attempt.error.slice(0, 120), asOf: state.attempt.at, fresh: false };
			const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			if (!meta?.convs[conversationId]?.title && state?.title?.title && summary.kind !== "worker") summary.title = state.title.title;
		},
		async react(store, conversationId, summary) {
			// agent_settled: a stop with nothing running or queued, decided once per stop entry (RarebitDoc.trigger and the
			// `running` mark are the durable decision; a mark from an older boot is a crashed attempt and is redone).
			if (summary.activity !== "idle" || summary.queued > 0) return;
			const id = Number(conversationId) as ConversationId;
			const last = select(await history(store, conversationId).load()).occurrences.at(-1);
			if (last?.outcome !== "stop") return;
			const state = await store.harness.snapshot(RarebitDoc, id, BACKGROUND_CONTEXT);
			const running = state?.running;
			const stale = running !== undefined && running.boot !== BOOT;
			if (state?.trigger !== last.sourceEntryId && (!running || stale))
				void summarizeNow(store, conversationId, "agent_settled", last.sourceEntryId).catch((error) => runtimeOf(store).report(error));
			const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			if (!state?.title && !meta?.convs[conversationId]?.title && summary.kind !== "worker") titleNow(store, conversationId);
		},
	};
}
