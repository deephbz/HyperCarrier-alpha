// Rarebit selects evidence from durable history. Only Title starts a model job.
// Old Summary receipts stay stored but do not enter views or start work.

import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import {
	type Completion,
	deriveTitle,
	RarebitDoc,
	type RarebitState,
	rarebitExtension,
	select,
} from "@hypercarrier/rarebit-durable";
import { contentText } from "../node/projection.ts";
import { type Effect, EffectAborted, MetaDoc, NodeError, type NodePlugin, type NodeRuntime, parseThreadKey, type Store } from "../node/runtime.ts";
import { type TopicSource, topics } from "../node/server.ts";
import { defaultModel } from "../node/models.ts";
import type { CommandAck } from "../shared/protocol.ts";
import { CommandsDoc, type CommandResult } from "../node/commands.ts";

const BOOT = randomBytes(4).toString("hex");
const TEXT_LIMIT = 6_000;
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

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
		state: { ...(state?.title ? { title: state.title } : {}) } as JsonValue,
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

type CommandPort = (conversationId: string, args: string, key?: string) => Promise<CommandResult>;
const commandPorts = new WeakMap<Store, CommandPort>();
/** Called inside runtime.admit; the plugin owns jobs and their receipts. */
export function rarebitCommand(store: Store, conversationId: string, args: string, key?: string): Promise<CommandResult> {
	const port = commandPorts.get(store);
	if (!port) throw new NodeError("unavailable", "Rarebit is unavailable on this node.");
	return port(conversationId, args, key);
}

function manualResult(state: RarebitState): { notice: string } {
	return { notice: state.title?.title ? `Title derived: ${state.title.title}` : "Title derivation failed; no title was applied." };
}

export function rarebitPlugin(): NodePlugin {
	const jobs = new Map<string, Promise<void>>();
	const activeCommands = new Set<string>();

	async function complete(store: Store, conversationId: string, prompt: string, effect: Effect): Promise<Completion> {
		const configured = process.env.AMPI_RAREBIT_MODEL;
		let ref: { provider: string; modelId: string } | undefined;
		if (configured?.includes("/")) {
			const [provider, ...rest] = configured.split("/");
			ref = { provider: provider!, modelId: rest.join("/") };
		}
		if (!ref) {
			const { AgentDoc } = await import("@earendil-works/pi-durable");
			const agent = await store.harness.snapshot(AgentDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
			ref = agent?.model ?? (await defaultModel(effect.models));
		}
		const model = effect.models.getModel(ref.provider, ref.modelId);
		if (!model) throw new Error(`No model ${ref.provider}/${ref.modelId}`);
		const message = await effect.start((signal) =>
			effect.models.completeSimple(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
				{ maxTokens: 2048, signal },
			),
		);
		if (process.env.AMPI_FAULT === "after-rarebit-command-response" && [...activeCommands].some(key => key.startsWith(`${store.threadKey(conversationId)}/`))) process.kill(process.pid, "SIGKILL");
		if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? `model ${message.stopReason}`);
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { text: string }).text)
			.join("");
		return { text, model: `${ref.provider}/${ref.modelId}`, costUsd: message.usage?.cost?.total };
	}

	async function change(effect: Effect, conversationId: string, fn: (state: RarebitState) => void, completed?: { action: "title"; store: Store }): Promise<void> {
		await effect.commit(async (tx) => {
			const state = await tx.doc(RarebitDoc, Number(conversationId) as ConversationId);
			fn(state);
			if (completed) for (const [key, command] of Object.entries(state.commands ?? {}))
				if (!command.result && command.action === completed.action && activeCommands.has(`${completed.store.threadKey(conversationId)}/${key}`)) command.result = manualResult(state);
		});
	}

	/** A job aborted by Close or a stop ends quietly: it wrote nothing after the abort. */
	const unlessAborted = (error: unknown) => {
		if (!(error instanceof EffectAborted)) throw error;
	};

	/** One Title job per conversation. Close and stop fence its model call and receipt. */
	function titleNow(store: Store, conversationId: string): Promise<void> {
		const key = `title:${store.threadKey(conversationId)}`;
		const existing = jobs.get(key);
		if (existing) return existing;
		const job = runtimeOf(store)
			.effect(store, conversationId, async (effect) => {
				const entries = await history(store, conversationId).load();
				const title = await deriveTitle({ entries, complete: (prompt) => complete(store, conversationId, prompt, effect) }).catch((error) => {
					if (error instanceof EffectAborted) throw error;
					runtimeOf(store).report(error);
					return undefined;
				});
				await change(effect, conversationId, (s) => {
					s.title = title ?? { title: "", sourceEntryId: "", model: "", at: Date.now() };
				}, { action: "title", store });
			})
			.catch(unlessAborted)
			.catch((error) => runtimeOf(store).report(error))
			.finally(() => jobs.delete(key));
		jobs.set(key, job);
		return job;
	}

	async function command(store: Store, conversationId: string, args: string, suppliedKey?: string): Promise<CommandResult> {
		const [action = "status", ...rest] = args.split(/\s+/).filter(Boolean);
		const reply = (notice: string, body?: string): CommandAck => ({ via: "node", disposition: "handled", notice, ...(body ? { body } : {}) });
		const alternatives: Record<string, string> = {
			settings: "uses the node's Rarebit policy; use /rarebit status",
			fork: "forks through the Session toolbar",
			btw: "opens independent threads through New Session",
			config: "uses the node's Rarebit policy; use /rarebit status",
			"auto-title": "derives a title after a settled run unless the owner set a name",
		};
		if (action === "recall") return reply("Durable has no recall yet; use Find.");
		if (alternatives[action]) return reply(`${action}: not on durable threads. Durable ${alternatives[action]}.`);
		if (rest.length) throw new NodeError("bad_args", `/rarebit ${action} takes no arguments.`);
		if (action === "view" || action === "menu") return { ...reply("Opened the Rarebit panel"), panel: "rarebit" };
		if (action === "help") return reply("Rarebit commands", "Rarebit commands\nstatus; title; view; menu; help\nPi pane only: recall, settings, fork, btw, config, auto-title");
		const id = Number(conversationId) as ConversationId;
		const state = await store.harness.snapshot(RarebitDoc, id, BACKGROUND_CONTEXT);
		if (action === "status") {
			return reply("Rarebit status", [
				"Rarebit status",
				state?.title ? `Title: ${state.title.title ? `derived ${state.title.title}` : "failed"} · ${clock(state.title.at)}` : "Title: none yet",
			].join("\n"));
		}
		if (action !== "title") throw new NodeError("bad_args", "Use /rarebit help for durable commands.");
		const key = suppliedKey ?? randomBytes(16).toString("hex");
		const prior = state?.commands?.[key];
		if (prior?.result) return reply(prior.result.notice);
		if (prior) return reply(`Rarebit ${action}: interrupted; the result is unknown. Run /rarebit ${action} again.`);
		if (Object.values(state?.commands ?? {}).filter(c => !c.result).length >= 200) throw new NodeError("unavailable", "Rarebit has 200 interrupted command attempts; inspect this thread before starting more.");
		const entries = await history(store, conversationId).load();
		const last = select(entries).occurrences.at(-1);
		if (!last) throw new NodeError("bad_request", "This thread has no Rarebits yet.");
		await store.harness.commit(async tx => {
			const doc = await tx.doc(RarebitDoc, id);
			doc.commands ??= {};
			doc.commands[key] = { action, boot: BOOT, at: Date.now(), coveredEntryId: last.sourceEntryId };
			const settled = Object.entries(doc.commands).filter(([, c]) => c.result).sort((a, b) => a[1].at - b[1].at);
			for (const [old] of settled.slice(0, Math.max(0, settled.length - 199))) delete doc.commands[old];
		}, BACKGROUND_CONTEXT);
		if (process.env.AMPI_FAULT === "after-rarebit-command-intent") process.kill(process.pid, "SIGKILL");
		const active = `${store.threadKey(conversationId)}/${key}`;
		activeCommands.add(active);
		const job = titleNow(store, conversationId);
		const completion = job.finally(() => activeCommands.delete(active)).then(async () => {
			const result = (await store.harness.snapshot(RarebitDoc, id, BACKGROUND_CONTEXT))?.commands?.[key]?.result;
			if (process.env.AMPI_FAULT === "after-rarebit-command-result") process.kill(process.pid, "SIGKILL");
			return reply(result?.notice ?? `Rarebit ${action}: interrupted; the result is unknown. Run /rarebit ${action} again.`);
		});
		return { completion };
	}

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
		async attach(store, runtime) {
			owners.set(store, runtime);
			runtimes.add(runtime);
			commandPorts.set(store, (conversationId, args, key) => command(store, conversationId, args, key));
			// Settle each conversation once before resume. The marker commits with settlement; no model work starts.
			const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			const notice = "Rarebit Summary is retired. Use Timeline or Arcs.";
			for (const [conversationId, conv] of Object.entries(meta?.convs ?? {})) {
				if (conv.rarebitSummaryRetired) continue;
				const id = Number(conversationId) as ConversationId;
				const state = await store.harness.snapshot(RarebitDoc, id, BACKGROUND_CONTEXT);
				const commands = await store.harness.snapshot(CommandsDoc, id, BACKGROUND_CONTEXT);
				const pending = Object.entries(commands?.keys ?? {}).filter(([, c]) => c.name === "rarebit" && ["summarize", "recap"].includes(c.args) && !c.reply);
				await store.harness.commit(async tx => {
					(await tx.doc(MetaDoc)).convs[conversationId]!.rarebitSummaryRetired = true;
					if (!state?.running && !Object.values(state?.commands ?? {}).some(c => c.action === "summarize" && !c.result) && !pending.length) return;
					const doc = await tx.doc(RarebitDoc, id);
					if (doc.running) {
						doc.retiredSummary = { at: Date.now(), notice };
						delete doc.running;
					}
					for (const command of Object.values(doc.commands ?? {}))
						if (command.action === "summarize" && !command.result) command.result = { notice };
					if (pending.length) {
						const ledger = await tx.doc(CommandsDoc, id);
						for (const [key] of pending) ledger.keys[key]!.reply = { via: "node", disposition: "handled", notice };
					}
				}, BACKGROUND_CONTEXT);
			}
		},
		async summarize(store, conversationId, summary) {
			const id = Number(conversationId) as ConversationId;
			const state = await store.harness.snapshot(RarebitDoc, id, BACKGROUND_CONTEXT);
			const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			if (!meta?.convs[conversationId]?.title && state?.title?.title && summary.kind !== "worker") summary.title = state.title.title;
		},
		async react(store, conversationId, summary) {
			// A settled stop may derive a Title. Legacy Summary intents never authorize work.
			if (summary.activity !== "idle" || summary.queued > 0) return;
			const id = Number(conversationId) as ConversationId;
			const last = select(await history(store, conversationId).load()).occurrences.at(-1);
			if (last?.outcome !== "stop") return;
			const state = await store.harness.snapshot(RarebitDoc, id, BACKGROUND_CONTEXT);
			const interrupted = Object.values(state?.commands ?? {}).filter(c => !c.result);
			const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			if (!state?.title && !meta?.convs[conversationId]?.title && summary.kind !== "worker" && !interrupted.some(c => c.action === "title")) void titleNow(store, conversationId);
		},
	};
}
