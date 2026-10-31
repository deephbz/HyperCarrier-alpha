// Auto Compact in the AmPi node. When a response's context crosses the model's working budget W (C2), the node asks
// for a compaction; pi-durable summarizes while the agent keeps working and places the summary at the next boundary.
// Durable's own window-edge threshold stays as the hard floor. The keepset method (default) sends the conversation's
// last real request again with a planning prompt, so the provider serves it from cache; the plan is the working-state
// summary plus the tool outputs the model keeps verbatim. The summary method writes the working-state summary from a
// serialized range. Both add a Rarebit conversation record over the full durable history. Each compaction's method, trigger, and any
// fallback reason are recorded in the conversation's CompactDoc (C3) and shown in the thread.
// Pi's settings.json is the only settings source (src/node/compact-settings.ts); a thread's /auto-compact controls win.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryRecord, HookApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, CompactionTask, defineDoc } from "@earendil-works/pi-durable";
import { fallbackRun, plannerLine, recordDetail, recordLine } from "../shared/compact-record.ts";
import { type BudgetOptions, type CompactMethod, type CompactRecord, compactionSettings, compactTrigger, hcCompactExtension, keepCap, workingBudget } from "@hypercarrier/auto-compact-durable";
import { type CompactSettings, type CompactSettingsPort, compactSettingsPort } from "../node/compact-settings.ts";
import { MetaDoc, NodeError, type NodePlugin, type NodeRuntime, type Store } from "../node/runtime.ts";
import { lastRequest } from "./cache-goblin.ts";
import { history, storeById } from "./rarebit.ts";
import type { CommandAck } from "../shared/protocol.ts";

export type CompactState = {
	records: CompactRecord[];
	controls?: { enabled?: boolean; budgetTokens?: number; thresholdPercent?: number; method?: CompactMethod };
	/** Budget crossings the node decided to compact, by the assistant entry that crossed W; `taskId` once admitted. */
	budget?: { entryId: string; tokens: number; workingBudget: number; at: number; taskId?: string };
};
export const CompactDoc = defineDoc<CompactState>({
	kind: "hc.compact",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	// A fork starts its own compaction record.
	fork: "initial",
	initial: () => ({ records: [] }),
});

/**
 * One thread's W options: its /auto-compact controls, then the settings. A thread's budget also wins over the per-model
 * budget, as a Session's `/auto-compact budget` does in Pi. `model` is `"provider/modelId"`.
 */
export function budgetOptions(settings: CompactSettings, model: string | undefined, state?: CompactState): BudgetOptions {
	const controls = state?.controls ?? {};
	return {
		thresholdPercent: controls.thresholdPercent ?? settings.thresholdPercent,
		budgetTokens: controls.budgetTokens ?? settings.budgetTokens,
		modelBudgetTokens: controls.budgetTokens === undefined && model ? settings.modelBudgets[model] : undefined,
	};
}

/** pi-durable's harness-wide compaction settings: Pi's keep-recent, else the package default for the global budget. */
export function harnessCompaction(settings: CompactSettings) {
	const modelOverrides = Object.fromEntries(Object.entries(settings.modelKeepRecent).map(([model, keepRecentTokens]) => [model, { keepRecentTokens }]));
	return { ...compactionSettings({ budgetTokens: settings.budgetTokens, keepRecentTokens: settings.keepRecentTokens }), ...(Object.keys(modelOverrides).length ? { modelOverrides } : {}) };
}

/**
 * The recent tokens a compaction of `model` keeps, as pi-durable resolves them from `harnessCompaction`. Keep-recent
 * is harness-wide, so it comes from the global settings for every thread.
 */
function keepRecent(port: CompactSettingsPort, model: string | undefined): number {
	const settings = port.global();
	return (model ? settings.modelKeepRecent[model] : undefined) ?? harnessCompaction(settings).keepRecentTokens ?? 20_000;
}

const modelKey = (ref?: { provider: string; modelId: string }) => (ref ? `${ref.provider}/${ref.modelId}` : undefined);

const METHODS: readonly CompactMethod[] = ["keepset", "summary", "native"];
const METHOD_TEXT: Record<CompactMethod, string> = {
	keepset: "keepset: the model keeps chosen tool outputs verbatim; the planner reuses the cached last request",
	summary: "summary: the HC working-state summary, no kept outputs",
	native: "native: durable's own summary",
};

/** Fallbacks in a row at the end of the records: two or more say the planner is failing. */
/** The conversation's model, its context window, and the settings of its working directory. */
async function agentOf(port: CompactSettingsPort, api: HookApi, context: Context) {
	const agent = await api.snapshot(AgentDoc, api.conversationId, context);
	const ref = agent?.model;
	const window = ref ? api.models.getModel(ref.provider, ref.modelId)?.contextWindow : undefined;
	return { model: modelKey(ref), window, settings: port.forCwd(agent?.cwd) };
}

export async function compactStatus(port: CompactSettingsPort, runtime: NodeRuntime, store: Store, conversationId: ConversationId) {
	const state = await store.harness.snapshot(CompactDoc, conversationId, BACKGROUND_CONTEXT);
	const agent = await store.harness.snapshot(AgentDoc, conversationId, BACKGROUND_CONTEXT);
	const model = agent?.model ? runtime.models.getModel(agent.model.provider, agent.model.modelId) : undefined;
	const settings = port.forCwd(agent?.cwd);
	const options = budgetOptions(settings, modelKey(agent?.model), state);
	return { records: state?.records ?? [], enabled: state?.controls?.enabled ?? settings.enabled, method: state?.controls?.method ?? settings.method, thresholdPercent: options.thresholdPercent ?? 90,
		workingBudget: model?.contextWindow ? workingBudget(model.contextWindow, options) : null,
		trigger: model?.contextWindow ? compactTrigger(model.contextWindow, options) : null, contextWindow: model?.contextWindow ?? null,
		keepRecentTokens: keepRecent(port, modelKey(agent?.model)), settingsErrors: [...new Set([...settings.errors, ...port.global().errors])] };
}

/** Policy controls only. The command adapter sends manual runs through the existing compact admission. */
export async function compactCommand(port: CompactSettingsPort, runtime: NodeRuntime, thread: Awaited<ReturnType<NodeRuntime["thread"]>>, args: string): Promise<CommandAck> {
	const [option = "status", value, ...extra] = args.split(/\s+/).filter(Boolean);
	const reply = (notice: string, body?: string): CommandAck => ({ via: "node", disposition: "handled", notice, ...(body ? { body } : {}) });
	const alternatives: Record<string, string> = {
		execution: "runs summaries in background and places them at a turn boundary",
		preservation: "keeps recent context and stores full history for Rarebit",
	};
	if (alternatives[option]) return reply(`${option}: not on durable threads. Durable ${alternatives[option]}.`);
	if (option === "help" && !value) return reply("Auto Compact commands", "Auto Compact commands\nstatus; run [prompt]; on; off; method <keepset|summary|native>; budget <tokens|default>; threshold <percent>\nPi pane only: execution, preservation");
	if (option === "status" && !value) {
		const s = await compactStatus(port, runtime, thread.store, thread.conversation.id);
		const last = s.records.at(-1);
		return reply(`Auto Compact: ${s.enabled ? "on" : "off"}`, [
			`Auto Compact: ${s.enabled ? "on" : "off"}`,
			`Working budget W: ${s.workingBudget ?? "unknown"} tokens; trigger: ${s.trigger ?? "unknown"} (${s.thresholdPercent}%)`,
			`Method: ${METHOD_TEXT[s.method]}; native fallback on failure`,
			...(s.method === "keepset" ? [`Keep cap: ${keepCap(s.workingBudget ?? undefined)} tokens (min 20000, W/4); each output cut at 8000`] : []),
			"Pi window-edge safety: on (always)",
			`Keep recent: ${s.keepRecentTokens} tokens (node policy); HC waits for at least ${2 * s.keepRecentTokens} message tokens before compacting`,
			...(s.settingsErrors.length ? [`Ignored invalid Pi settings: ${s.settingsErrors.join("; ")}`] : []),
			`Compaction records: ${s.records.length}`,
			last ? `Latest: ${new Date(last.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} · ${last.reason} · ${recordLine(last)}` : "No compaction records yet.",
			...(last && plannerLine(last) ? [`Planner: ${plannerLine(last)}`] : []),
			...(last ? recordDetail(last).filter((line) => line !== plannerLine(last)).map((line) => `Note: ${line}`) : []),
			...(fallbackRun(s.records) >= 2 ? [`Planner failing; summary only: ${fallbackRun(s.records)} fallbacks in a row`] : []),
		].join("\n"));
	}
	const valid = extra.length === 0 && (
		((option === "on" || option === "off") && value === undefined) ||
		(option === "budget" && (value === "default" || (value !== undefined && Number.isSafeInteger(Number(value)) && Number(value) > 0))) ||
		(option === "method" && METHODS.includes(value as CompactMethod)) ||
		(option === "threshold" && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 100));
	if (!valid) throw new NodeError("bad_args", "Use /auto-compact status, run [prompt], on, off, method <keepset|summary|native>, budget <tokens|default>, or threshold <percent>.");
	await thread.store.harness.commit(async tx => {
		const doc = await tx.doc(CompactDoc, thread.conversation.id);
		doc.controls ??= {};
		const controls = doc.controls;
		if (option === "on" || option === "off") controls.enabled = option === "on";
		else if (option === "method") controls.method = value as CompactMethod;
		else if (option === "budget") {
			if (value === "default") delete controls.budgetTokens;
			else controls.budgetTokens = Number(value);
		} else controls.thresholdPercent = Number(value);
	}, BACKGROUND_CONTEXT);
	runtime.refresh(thread.store, thread.conversationId);
	return reply(option === "on" || option === "off" ? `Auto Compact: ${option}; Pi\'s window-edge safety stays on.` : option === "method" ? `Auto Compact method: ${METHOD_TEXT[value as CompactMethod]}` : `Auto Compact ${option}: ${value}`);
}

export function compactPlugin(port: CompactSettingsPort = compactSettingsPort()): NodePlugin {
	/** Working directories of the summarized threads: their project settings feed `inputs` too. */
	const cwds = new Set<string>();
	/** Conversations whose budget decision this process is acting on right now (decided, compact() not yet recorded). */
	const acting = new Set<string>();
	const storeOf = async (api: { snapshot: (...args: never[]) => Promise<unknown> }, context: typeof BACKGROUND_CONTEXT) => {
		const meta = (await (api.snapshot as (token: unknown, context: unknown) => Promise<{ store?: string } | undefined>)(MetaDoc, context)) ?? {};
		if (!meta.store) throw new Error("storage unknown");
		return storeById(meta.store);
	};
	return {
		ops: {
			"compact.records": async (args, runtime) => {
				const { store, conversation } = await runtime.thread(String(args.threadId));
				return compactStatus(port, runtime, store, conversation.id);
			},
		},
		commands: { "auto-compact": (runtime, thread, args) => compactCommand(port, runtime, thread, args) },
		// Stamps only: a changed stamp refreshes the summaries, and only they parse the files.
		inputs: () => [port.stamp(), ...[...cwds].map((cwd) => port.stamp(cwd))].join("\n"),
		// Pi's Auto Compact warns about ignored settings; the global file is one fact for the whole node.
		nodeState: () => {
			const { stamp, errors } = port.global();
			return errors.length ? { settingsNotice: { stamp, errors, file: port.file() } } : {};
		},
		extensions: [
			hcCompactExtension({
				history: async (api, context) => history(await storeOf(api as never, context), String(api.conversationId)).load(),
				method: async (api, context) =>
					(await api.snapshot(CompactDoc, api.conversationId, context))?.controls?.method ?? (await agentOf(port, api, context)).settings.method,
				lastRequest,
				workingBudget: async (api, context) => {
					const { model, window, settings } = await agentOf(port, api, context);
					return window ? workingBudget(window, budgetOptions(settings, model, await api.snapshot(CompactDoc, api.conversationId, context))) : undefined;
				},
				trigger: async (api, context) => {
					const { model, window, settings } = await agentOf(port, api, context);
					return window ? compactTrigger(window, budgetOptions(settings, model, await api.snapshot(CompactDoc, api.conversationId, context))) : undefined;
				},
				// Fault injection for the crash tests: die after the plan memo, before the summary is installed. The
				// `-native` variant first switches the thread to the native method, as an owner command would.
				afterPlan: async (api) => {
					if (process.env.AMPI_FAULT === "after-keepset-plan-native") {
						const store = await storeOf(api as never, BACKGROUND_CONTEXT);
						await store.harness.commit(async (tx) => {
							const doc = await tx.doc(CompactDoc, api.conversationId as ConversationId);
							doc.controls = { ...doc.controls, method: "native" };
						}, BACKGROUND_CONTEXT);
					}
					if (process.env.AMPI_FAULT?.startsWith("after-keepset-plan")) process.kill(process.pid, "SIGKILL");
				},
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
		// Harness-wide; the node reads it at each use, so a settings edit reaches the next compaction.
		settings: () => ({ compaction: harnessCompaction(port.global()) }),
		async summarize(store, conversationId, summary) {
			const state = await store.harness.snapshot(CompactDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
			if (summary.cwd) cwds.add(summary.cwd);
			if (summary.contextWindow) summary.workingBudget = workingBudget(summary.contextWindow, budgetOptions(port.forCwd(summary.cwd), summary.model, state));
		},
		async react(store, conversationId, summary) {
			// W is the owner's figure; the request starts at the threshold share of W, as Pi's Auto Compact does (K2.I1).
			const state = await store.harness.snapshot(CompactDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
			const settings = port.forCwd(summary.cwd);
			if (!(state?.controls?.enabled ?? settings.enabled)) return;
			const options = budgetOptions(settings, summary.model, state);
			const budget = summary.contextWindow ? workingBudget(summary.contextWindow, options) : undefined;
			const trigger = summary.contextWindow ? compactTrigger(summary.contextWindow, options) : undefined;
			if (!budget || !trigger || !summary.contextTokens || summary.contextTokens < trigger || summary.activity === "compacting") return;
			const id = Number(conversationId) as ConversationId;
			const conversation = await store.conversation(conversationId);
			const page = await conversation.entries({}, 400, undefined, BACKGROUND_CONTEXT);
			const recent = page.items as EntryRecord[];
			const last = recent.find((entry) => entry.kind === "pi.assistant");
			if (!last) return;
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
			const keep = keepRecent(port, summary.model);
			if (messageTokens < 2 * keep) return;
			// HC trigger single-flight: no budget compaction starts while a compaction task (any reason) is live, or a
			// finished one's summary waits for the turn boundary. Every response above the trigger is a new crossing, and
			// the thread's activity does not say "compacting" while a run is live, so without this each response started
			// another full summary over the same range. Once the summary is placed, the messages-since-compaction rule
			// above asks for new turns before the next one. Known gap: durable's blocking-threshold and overflow
			// compactions, and manual ones, do not check for a live compaction (docs/current/now.md, Deferred).
			const inspection = await store.harness.inspect(BACKGROUND_CONTEXT);
			const mine = (conversationOf: unknown) => Number(conversationOf) === Number(id);
			const task = inspection.tasks.find((t) => t.record.kind === CompactionTask.definition.name && mine(t.record.conversationId));
			const placing = inspection.submissions.find((s) => s.type === "write" && s.status === "queued" && mine(s.conversationId) && s.requestId?.startsWith("compaction:"));
			const inFlight = task ? String(task.record.id) : placing?.requestId?.slice("compaction:".length);
			// Decide durably, then act. The check and the decision are one commit; the decision is pending until it names
			// its task, so a restart finishes a pending decision and a repeated refresh never starts a second task.
			// A pending decision whose compaction already exists (the node died after compact() admitted the task, before
			// the task was recorded here, and it is placed or still in flight) is done, not a reason to compact again.
			const existing = recent.some((entry) => entry.kind === "pi.compaction" && Number(entry.id) > Number(crossing)) ? "recovered" : inFlight;
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
				// A newer crossing while one is in flight leaves the earlier decision, and its task's label, in place.
				if (inFlight) return false;
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
