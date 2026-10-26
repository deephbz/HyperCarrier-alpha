// The one spend rule (apps/trace-analytics/src/sources/spend.mjs), typed for the hub and the web.
// The label's words live there; every cost figure that Pi and durable figures share prints through it.
// @ts-ignore: shared reader is plain ESM.
import * as rule from "../../../trace-analytics/src/sources/spend.mjs";

export type SpendClass = "responses" | "failed" | "compaction" | "tools";
/** A cost figure and the request classes it counts. `usd` is null when no price was reported. */
export type Spend = { usd: number | null; covers: SpendClass[]; mixed?: true };

/** What a Session history's assistant entries hold: Pi rows and every Timeline lane, on both backends. */
export const HISTORY_COVERS: readonly SpendClass[] = rule.HISTORY_COVERS;
export const ALL_COVERS: readonly SpendClass[] = rule.CLASSES;

/** The label a view shows: the amount as money() prints it, plus what the figure leaves out. */
export const spendLabel = (spend: Spend): string => rule.spendLabel(spend);
/** What a figure leaves out, as the label prints it: "" when it counts every class. */
export const spendSuffix = (spend: Spend): string => rule.spendSuffix(spend);
/** A summary's figure; a summary without one (an older Host) shows its bare amount. */
export const summarySpend = (s: { costUsd: number; spend?: Spend }): Spend => s.spend ?? { usd: s.costUsd, covers: [...ALL_COVERS] };
/** A history-derived figure: a cost total summed over entries, or null when no entry carried a price. */
export const historySpend = (usd: number | null): Spend => ({ usd, covers: [...HISTORY_COVERS] });
/** The sum of several figures, covering only what every one covers; `mixed` when they differ. */
export function sumSpend(figures: Spend[]): Spend {
	if (!figures.length) return { usd: 0, covers: [...ALL_COVERS] };
	const { usd, covers, mixed } = rule.teamSpend(figures.map((f) => ({ ...f, tokens: 0 })));
	return { usd, covers, ...(mixed ? { mixed } : {}) };
}
