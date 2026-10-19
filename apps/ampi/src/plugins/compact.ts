// Auto Compact in the AmPi node. When a response's context crosses the model's working budget W (C2), the node asks
// for a compaction; pi-durable summarizes while the agent keeps working and places the summary at the next boundary.
// Durable's own window-edge threshold stays as the hard floor. The HC summary method writes the working-state summary
// plus a Rarebit conversation record over the full durable history. Each compaction's method, trigger, and any
// fallback reason are recorded in the conversation's CompactDoc (C3) and shown in the thread.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { CompactionTask, defineDoc } from "@earendil-works/pi-durable";
import { type BudgetOptions, type CompactRecord, compactionSettings, hcCompactExtension, workingBudget } from "@hypercarrier/durable-compact";
import { MetaDoc, NodeError, type NodePlugin } from "../node/runtime.ts";
import { ops } from "../node/server.ts";
import { history, storeById } from "./rarebit.ts";

export type CompactState = {
	records: CompactRecord[];
	/** Budget crossings the node decided to compact, by the assistant entry that crossed W; `taskId` once admitted. */
	budget?: { entryId: string; tokens: number; workingBudget: number; at: number; taskId?: string };
};
export const CompactDoc = defineDoc<CompactState>({
	kind: "hc.compact",
	version: 1,
	scope: "conversation",
	history: "latest",
	// A fork starts its own compaction record.
	fork: "initial",
	initial: () => ({ records: [] }),
});

function num(name: string): number | undefined {
	const value = process.env[name];
	if (!value) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

export function budgetOptions(): BudgetOptions {
	return {
		thresholdPercent: num("AMPI_COMPACT_THRESHOLD"),
		budgetTokens: num("AMPI_WORKING_BUDGET"),
		keepRecentTokens: num("AMPI_COMPACT_KEEP_RECENT"),
	};
}

export function compactPlugin(): NodePlugin {
	/** Conversations whose budget decision this process is acting on right now (decided, compact() not yet recorded). */
	const acting = new Set<string>();
	const storeOf = async (api: { snapshot: (...args: never[]) => Promise<unknown> }, context: typeof BACKGROUND_CONTEXT) => {
		const meta = (await (api.snapshot as (token: unknown, context: unknown) => Promise<{ store?: string } | undefined>)(MetaDoc, context)) ?? {};
		if (!meta.store) throw new Error("storage unknown");
		return storeById(meta.store);
	};
	ops.set("compact.records", async (args, runtime) => {
		const { store, conversation } = await runtime.thread(String(args.threadId));
		const state = await store.harness.snapshot(CompactDoc, conversation.id, BACKGROUND_CONTEXT);
		const agent = await import("@earendil-works/pi-durable").then(({ AgentDoc }) => store.harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT));
		const model = agent?.model ? runtime.models.getModel(agent.model.provider, agent.model.modelId) : undefined;
		if (!model) throw new NodeError("not_found", "no model");
		return { records: state?.records ?? [], workingBudget: model.contextWindow ? workingBudget(model.contextWindow, budgetOptions()) : null, contextWindow: model.contextWindow ?? null };
	});
	return {
		extensions: [
			hcCompactExtension({
				history: async (api, context) => history(await storeOf(api as never, context), String(api.conversationId)).load(),
				record: async (api, record) => {
					const store = await storeOf(api as never, BACKGROUND_CONTEXT);
					await store.harness.commit(async (tx) => {
						const doc = await tx.doc(CompactDoc, api.conversationId as ConversationId);
						// The budget decision was recorded before compact() ran; match it by task (or, after a crash between
						// admission and recording the task, by being the only pending decision).
						// A decision without a task belongs to this compaction only while this process is still acting on it;
						// otherwise (a crash left it pending) a later owner-started compaction keeps its own label.
						const budget = doc.budget;
						const acted = budget?.taskId === undefined && acting.has(`${store.id}.${api.conversationId}`);
						if (budget && (budget.taskId === String(api.taskId) || acted) && record.reason === "manual") {
							record = { ...record, reason: "working_budget", trigger: { tokens: budget.tokens, workingBudget: budget.workingBudget } };
							budget.taskId = String(api.taskId);
						}
						doc.records.push(record);
						if (doc.records.length > 20) doc.records.splice(0, doc.records.length - 20);
					}, BACKGROUND_CONTEXT);
				},
			}),
		],
		settings: () => ({ compaction: compactionSettings(budgetOptions()) }),
		summarize(_store, _conversationId, summary) {
			if (summary.contextWindow) summary.workingBudget = workingBudget(summary.contextWindow, budgetOptions());
		},
		async react(store, conversationId, summary) {
			const budget = summary.workingBudget;
			if (!budget || !summary.contextTokens || summary.contextTokens <= budget || summary.activity === "compacting") return;
			const id = Number(conversationId) as ConversationId;
			const conversation = await store.conversation(conversationId);
			const page = await conversation.entries({}, 400, undefined, BACKGROUND_CONTEXT);
			const recent = page.items as EntryRecord[];
			const last = recent.find((entry) => entry.kind === "pi.assistant");
			if (!last) return;
			const state = await store.harness.snapshot(CompactDoc, id, BACKGROUND_CONTEXT);
			const crossing = String(last.id);
			// Done: this crossing already has a compaction task. (A pending decision without a task, left by a crash
			// between deciding and acting, falls through and is finished below.)
			if (state?.budget?.entryId === crossing && state.budget.taskId !== undefined) return;
			// When the fixed prompt (instructions, tools, project files) is most of W, compacting messages cannot bring the
			// context under W; ask only when the messages since the last compaction are worth summarizing.
			let messageTokens = 0;
			for (const entry of recent) {
				if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") break;
				for (const message of entry.model ?? []) messageTokens += Math.ceil(JSON.stringify((message as { content?: unknown }).content ?? "").length / 4);
			}
			const keep = compactionSettings(budgetOptions()).keepRecentTokens ?? 20_000;
			if (messageTokens < 2 * keep) return;
			// Decide durably, then act. The check and the decision are one commit; the decision is pending until it names
			// its task, so a restart finishes a pending decision and a repeated refresh never starts a second task.
			// A pending decision whose compaction already exists (the node died after compact() admitted the task, before
			// the task was recorded here) is done, not a reason to compact again.
			let existing: string | undefined = recent.some((entry) => entry.kind === "pi.compaction" && Number(entry.id) > Number(crossing)) ? "recovered" : undefined;
			if (!existing && state?.budget?.entryId === crossing) {
				// …or whose task is admitted and still live (it resumes on its own after the restart).
				const live = await store.harness.inspect(BACKGROUND_CONTEXT);
				const task = live.tasks.find((t) => t.record.kind === CompactionTask.definition.name && Number(t.record.conversationId) === Number(id));
				if (task) existing = String(task.record.id);
			}
			const decided = await store.harness.commit(async (tx) => {
				const doc = await tx.doc(CompactDoc, id);
				if (doc.budget?.entryId === crossing) {
					if (doc.budget.taskId !== undefined) return false;
					if (existing) {
						doc.budget.taskId = existing;
						return false;
					}
					return true;
				}
				doc.budget = { entryId: crossing, tokens: summary.contextTokens!, workingBudget: budget, at: Date.now() };
				return true;
			}, BACKGROUND_CONTEXT);
			if (!decided) return;
			// Fault injection for the crash test: die after deciding, before acting.
			if (process.env.AMPI_FAULT === "after-budget-decision") process.kill(process.pid, "SIGKILL");
			const key = `${store.id}.${conversationId}`;
			acting.add(key);
			try {
				const taskId = await conversation.compact(undefined, BACKGROUND_CONTEXT);
				if (process.env.AMPI_FAULT === "after-compact-admitted") process.kill(process.pid, "SIGKILL");
				await store.harness.commit(async (tx) => {
					const doc = await tx.doc(CompactDoc, id);
					if (doc.budget?.entryId === crossing && doc.budget.taskId === undefined) doc.budget.taskId = String(taskId);
				}, BACKGROUND_CONTEXT);
			} finally {
				acting.delete(key);
			}
		},
	};
}
