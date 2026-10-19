// Rarebit, adapted to pi-durable. Rarebits are the sparse human-readable evidence of a conversation: user messages,
// assistant prose at tool continuations, and assistant prose at stops. They are selected from the full fork-aware
// durable history, so they survive compaction and resets that drop them from model context.
//
// The pure selector, measurement, eligibility, prompt, and normalization rules are the existing Rarebit core
// (`@hypercarrier/rarebit/core`); this module only maps durable entries onto it and owns durable receipts:
// - RarebitDoc (conversation scope) holds the latest Summary and Title receipts, each naming the evidence it covers;
// - a Summary is an appearance-based Session assessment (finished / needs_attention), never liveness or delivery (P5);
// - `rarebit_recall` lets the agent reread exact earlier evidence that compaction removed from its context.

/// <reference path="./rarebit-core.d.ts" />
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type EntryRecord, type ToolExecutionApi } from "@earendil-works/pi-durable";
import {
	composeRarebitSummaryDerivationInput,
	composeRarebitTitlePrompt,
	DEFAULT_RAREBIT_SUMMARY_POLICY,
	evaluateRarebitSummaryEligibility,
	measureRarebits,
	normalizeRarebitSummarySynthesis,
	normalizeRarebitTitle,
	RAREBIT_SUMMARY_PROMPT_VERSION,
	selectRarebits,
} from "@hypercarrier/rarebit/core";

export type Outcome = "user" | "continuation" | "stop";
export type Occurrence = {
	occurrenceId: string;
	/** Durable entry ID (string). */
	sourceEntryId: string;
	order: number;
	role: "user" | "assistant";
	outcome: Outcome;
	timestamp: string | null;
	contentHash: string;
	text: string;
};
/** The core selection with durable occurrences: every branch entry carries its durable entry ID, so sourceEntryId is set. */
export type Selection = Omit<ReturnType<typeof selectRarebits>, "occurrences"> & { occurrences: Occurrence[] };
export type Boundary = "agent_settled" | "manual";
export type SummaryStatus = "finished" | "needs_attention";

export type SummaryReceipt = {
	status: "summarized";
	sessionStatus: SummaryStatus;
	statusReason: string;
	summary: string;
	boundary: Boundary;
	/** Last Rarebit occurrence this receipt covers; the receipt is fresh while it is still the last one. */
	coveredEntryId: string;
	manifestHash: string;
	coverage: { totalMessageCount: number; includedMessageCount: number; omittedMessageCount: number; complete: boolean };
	model: string;
	promptVersion: string;
	at: number;
	costUsd?: number;
};
export type IneligibleReceipt = {
	status: "ineligible";
	reasons: string[];
	boundary: Boundary;
	coveredEntryId: string;
	manifestHash: string;
	estimatedTotalTokens: number;
	rarebitRatio: number | null;
	at: number;
};
export type FailedReceipt = {
	status: "error";
	error: string;
	boundary: Boundary;
	coveredEntryId: string;
	manifestHash: string;
	model?: string;
	at: number;
};
export type Receipt = SummaryReceipt | IneligibleReceipt | FailedReceipt;

export type RarebitState = {
	/** The latest Summary attempt's outcome. A newer attempt replaces it; failures never erase the last summary. */
	summary?: SummaryReceipt;
	attempt?: Receipt;
	/** A derivation in flight: which evidence, since when. */
	running?: { boundary: Boundary; coveredEntryId: string; since: number; boot?: string };
	/** The stop entry whose settled boundary was last handled, so each stop is summarized at most once. */
	trigger?: string;
	title?: { title: string; sourceEntryId: string; model: string; at: number };
};

export const RarebitDoc = defineDoc<RarebitState>({
	kind: "rarebit.state",
	version: 1,
	scope: "conversation",
	history: "latest",
	// A fork diverges from the fork point, so the parent's receipts (which may cover later evidence) do not carry over.
	fork: "initial",
	initial: () => ({}),
});

/** Entry kinds that carry human or agent prose. Custom notices (Team deliveries) are machine traffic, not evidence. */
const PROSE_KINDS = new Set(["pi.user", "pi.assistant"]);

/** Durable entries (ascending) → Pi-shaped branch entries, the input the Rarebit core selects from. */
export function toPiBranch(entries: readonly EntryRecord[]): unknown[] {
	const branch: unknown[] = [];
	for (const entry of entries) {
		if (!PROSE_KINDS.has(entry.kind)) continue;
		// biome-ignore lint: pi-ai messages are loosely typed here on purpose
		const message = entry.model?.[0] as any;
		if (!message) continue;
		branch.push({
			type: "message",
			id: String(entry.id),
			timestamp: typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : null,
			message,
		});
	}
	return branch;
}

export function select(entries: readonly EntryRecord[]): Selection & { branch: unknown[] } {
	const branch = toPiBranch(entries);
	const selection = selectRarebits(branch) as Selection;
	return { ...selection, branch };
}

export type SummaryPolicy = { minTotalLength: number; maxRarebitRatio: number };
export const DEFAULT_POLICY: SummaryPolicy = {
	minTotalLength: DEFAULT_RAREBIT_SUMMARY_POLICY.minTotalLength,
	maxRarebitRatio: DEFAULT_RAREBIT_SUMMARY_POLICY.maxRarebitRatio,
};

export type Completion = { text: string; model: string; costUsd?: number };

/**
 * Derive one Summary receipt. `agent_settled` applies the eligibility policy (long, sparse sessions only); `manual`
 * is the owner asking and skips it. The model call is the only side effect.
 */
export async function deriveSummary(input: {
	entries: readonly EntryRecord[];
	boundary: Boundary;
	policy?: SummaryPolicy;
	complete: (prompt: string) => Promise<Completion>;
	now?: () => number;
	maxPromptChars?: number;
}): Promise<Receipt | undefined> {
	const now = input.now ?? Date.now;
	const selection = select(input.entries);
	const last = selection.occurrences.at(-1);
	if (!last) return undefined;
	const base = { boundary: input.boundary, coveredEntryId: last.sourceEntryId, manifestHash: selection.manifestHash };
	if (input.boundary === "agent_settled") {
		const measurement = measureRarebits(selection.branch, selection);
		const eligibility = evaluateRarebitSummaryEligibility(measurement, { ...DEFAULT_RAREBIT_SUMMARY_POLICY, ...input.policy });
		if (!eligibility.eligible)
			return {
				status: "ineligible",
				reasons: eligibility.reasons,
				...base,
				estimatedTotalTokens: measurement.estimatedTotalTokens,
				rarebitRatio: measurement.rarebitRatio,
				at: now(),
			};
	}
	const derivation = composeRarebitSummaryDerivationInput(selection, {
		lifecycleBoundary: input.boundary,
		maxPromptChars: input.maxPromptChars ?? 120_000,
	});
	let completion: Completion | undefined;
	try {
		completion = await input.complete(derivation.prompt);
		const synthesis = normalizeRarebitSummarySynthesis(stripFence(completion.text));
		return {
			status: "summarized",
			sessionStatus: synthesis.sessionStatus as SummaryStatus,
			statusReason: synthesis.statusReason,
			summary: synthesis.summary,
			...base,
			coverage: {
				totalMessageCount: derivation.coverage.totalMessageCount,
				includedMessageCount: derivation.coverage.includedMessageCount,
				omittedMessageCount: derivation.coverage.omittedMessageCount,
				complete: derivation.coverage.complete,
			},
			model: completion.model,
			promptVersion: RAREBIT_SUMMARY_PROMPT_VERSION,
			at: now(),
			...(completion.costUsd ? { costUsd: completion.costUsd } : {}),
		};
	} catch (error) {
		return { status: "error", error: (error as Error).message, ...base, ...(completion ? { model: completion.model } : {}), at: now() };
	}
}

/** Models often wrap JSON in a Markdown fence despite instructions; accept exactly one fenced object. */
function stripFence(text: string): string {
	const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
	return match ? match[1]! : text;
}

export async function deriveTitle(input: {
	entries: readonly EntryRecord[];
	complete: (prompt: string) => Promise<Completion>;
	now?: () => number;
}): Promise<RarebitState["title"] | undefined> {
	const selection = select(input.entries);
	const first = selection.occurrences.find((o) => o.outcome === "user");
	if (!first) return undefined;
	const completion = await input.complete(composeRarebitTitlePrompt(selection));
	return { title: normalizeRarebitTitle(completion.text, { maxChars: 80 }), sourceEntryId: first.sourceEntryId, model: completion.model, at: (input.now ?? Date.now)() };
}

/** Whether the latest Summary still covers the latest evidence. */
export function freshness(state: RarebitState | undefined, lastOccurrenceId: string | undefined): boolean {
	return !!state?.summary && state.summary.coveredEntryId === lastOccurrenceId;
}

/** Where the recall tool reads a conversation's full durable history (ascending), supplied by the host. */
export type RarebitSource = (api: ToolExecutionApi, context: Context) => Promise<readonly EntryRecord[]>;

const RECALL_GUIDE = `Rarebit recall: your context may have been compacted. The user's exact earlier words and your own earlier prose answers are still in the durable record. Call rarebit_recall to reread them (filter with query) before relying on a summary for a precise requirement, name, number, or decision.`;

export function rarebitExtension(source: RarebitSource) {
	const recall = defineTool({
		name: "rarebit_recall",
		description:
			"Reread exact earlier user messages and assistant prose from this conversation's full durable history, including parts compaction removed from your context. Tool calls and results are not included.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Case-insensitive words; every word must appear." })),
			role: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("any")])),
			limit: Type.Optional(Type.Number({ description: "Most recent matches to return (default 12, max 50)." })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const entries = await source(api, context);
			const { occurrences } = select(entries);
			const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			const role = args.role ?? "any";
			const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 12)));
			const matches = occurrences.filter(
				(o) => (role === "any" || o.role === role) && words.every((w) => o.text.toLowerCase().includes(w)),
			);
			const shown = matches.slice(-limit);
			const text = shown.length
				? shown
						.map((o) => `[${o.sourceEntryId} ${o.role}/${o.outcome}${o.timestamp ? ` ${o.timestamp}` : ""}]\n${o.text.length > 4000 ? `${o.text.slice(0, 4000)}…` : o.text}`)
						.join("\n\n")
				: "No Rarebit matches.";
			return {
				output: [{ type: "text", text: `${matches.length} of ${occurrences.length} Rarebits match; showing ${shown.length}.\n\n${text}` }],
				details: { total: occurrences.length, matches: matches.length, shown: shown.map((o) => o.sourceEntryId) },
			};
		},
	});
	return defineExtension({
		name: "Rarebit",
		tools: [recall],
		sections: [{ key: "rarebit", render: () => RECALL_GUIDE }],
	});
}
