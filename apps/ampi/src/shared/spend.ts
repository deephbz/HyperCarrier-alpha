// The one spend rule (apps/trace-analytics/src/sources/spend.mjs), typed for the hub and the web.
// The label's words live there; every cost figure that Pi and durable figures share prints through it.
// @ts-ignore: shared reader is plain ESM.
import * as rule from "../../../trace-analytics/src/sources/spend.mjs";

export type SpendClass = "responses" | "failed" | "compaction" | "tools";
/**
 * A cost figure and the request classes it counts. `usd` is null when no price was reported. `unread`: how many
 * Sessions the figure could not count yet (ThreadSummary.updating); the rest of the figure is a lower bound.
 */
export type Spend = { usd: number | null; covers: SpendClass[]; mixed?: true; unread?: number };

/** What a Session history's assistant entries hold: Pi rows and every Timeline lane, on both backends. */
export const HISTORY_COVERS: readonly SpendClass[] = rule.HISTORY_COVERS;
export const ALL_COVERS: readonly SpendClass[] = rule.CLASSES;

/**
 * The label a view shows: the amount as money() prints it, plus what the figure leaves out. A figure with unread
 * Sessions is a lower bound: `≥ $X · N updating`, with the class text of its read Sessions only.
 */
export const spendLabel = (spend: Spend): string => !spend.unread ? rule.spendLabel(spend)
	: `${spend.usd === null ? "" : "≥ "}${rule.spendLabel(spend)} · ${spend.unread.toLocaleString()} updating`;
/** What a figure leaves out, as the label prints it: "" when it counts every class. */
export const spendSuffix = (spend: Spend): string => rule.spendSuffix(spend);
/** A summary's figure; a summary without one (an older Host) shows its bare amount. */
export const summarySpend = (s: { costUsd: number; spend?: Spend }): Spend => s.spend ?? { usd: s.costUsd, covers: [...ALL_COVERS] };
/**
 * The figure of a Session not read yet (ThreadSummary.updating). It counts no class, so a page that predates `unread`
 * still reads a sum over it as partial.
 */
export const unreadSpend = (): Spend => ({ usd: 0, covers: [], unread: 1 });
/** A history-derived figure: a cost total summed over entries, or null when no entry carried a price. */
export const historySpend = (usd: number | null): Spend => ({ usd, covers: [...HISTORY_COVERS] });
/** The sum of several figures, covering only what every read one covers; `mixed` when they differ. */
export function sumSpend(figures: Spend[]): Spend {
	const read = figures.filter((f) => !f.unread), unread = figures.reduce((n, f) => n + (f.unread ?? 0), 0);
	const sum: Spend = { usd: 0, covers: [...ALL_COVERS] };
	if (read.length) {
		const { usd, covers, mixed } = rule.teamSpend(read.map((f) => ({ ...f, tokens: 0 })));
		Object.assign(sum, { usd, covers }, mixed ? { mixed } : {});
	}
	return unread ? { ...sum, unread } : sum;
}
