import type { CompactRecord } from "@hypercarrier/auto-compact-durable";
import { NO_CAPTURE, NO_FIT } from "@hypercarrier/auto-compact-durable/keepset";

/** Native fallbacks at the end of the record list: two or more mean the planner keeps failing. */
export const fallbackRun = (records: readonly CompactRecord[]) => {
	let n = 0;
	while (n < records.length && records[records.length - 1 - n]!.method === "native-fallback") n++;
	return n;
};

const k = (n: number | undefined) => (n === undefined ? "?" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Under half the planner's prompt came from cache: the owner paid for most of it again. */
const mostlyUncached = (r: CompactRecord) => r.planner !== undefined && r.planner.promptTokens > 0 && r.planner.usage.cacheRead / r.planner.promptTokens < 0.5;

/** The fit arithmetic when the summary did not fit under the trigger. */
const fitReason = (r: CompactRecord) => [r.planRejected, r.error].find((reason) => reason?.startsWith(NO_FIT));

/** The planner went through the Claude subscription bridge, which does not reuse the conversation's cache (known gap). */
const onBridge = (r: CompactRecord) => r.planner?.model.startsWith("claude/") === true;

/** Why a fallback installed durable's summary, in the owner's words. The record keeps the machine reason. */
function fallbackReason(r: CompactRecord): string {
	if (fitReason(r)) return "plan too large for the window";
	if (r.planRejected) return `plan rejected: ${r.planRejected}`;
	if (r.error === `no cache reuse: ${NO_CAPTURE}`) return "first compaction after a restart; planner has no cached request yet";
	return r.error ?? "fallback";
}

/** The collapsed line for a record: method and outcome. The planner's cost is plannerLine. */
export function recordLine(r: CompactRecord): string {
	const uncached = mostlyUncached(r) ? " · planner mostly uncached" : "";
	if (r.method === "keepset" && r.keep)
		return `keepset · ${entries(r.replacedEntries)} replaced · ${plural(r.keep.kept.length, "output")} kept (${k(r.keep.keptTokens)} of ${k(r.keep.cap)}) · ${r.keep.droppedCount} dropped${uncached}`;
	if (r.method === "native-fallback") return `summary only (${fallbackReason(r)})${uncached}`;
	return `${r.method === "hc-summary" ? "summary" : r.method} · ${entries(r.replacedEntries)} replaced`;
}

/**
 * The transcript row's words: what happened, with no method name or figures, so the row stays on one line at the
 * owner's 130 %. "low cache" stands for "planner mostly uncached". recordLine keeps the method and the figures for the
 * title, the panel, and the status.
 */
export function rowLine(r: CompactRecord): string {
	const uncached = mostlyUncached(r) ? " · low cache" : "";
	if (r.method === "keepset" && r.keep)
		return `${entries(r.replacedEntries)} replaced · ${plural(r.keep.kept.length, "output")} kept · ${r.keep.droppedCount} dropped${uncached}`;
	if (r.method === "native-fallback") return `summary only (${fallbackReason(r)})${uncached}`;
	return `${entries(r.replacedEntries)} replaced`;
}

/** The transcript row's start: an owner-started compaction says so; an automatic one does not. */
export const rowHead = (r: CompactRecord) => (r.reason === "manual" ? "Compacted (manual)" : "Compacted");

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const entries = (n: number) => (n === 1 ? "1 entry" : `${n} entries`);

/** What the owner can do after a plan too large for the window. Each compaction plans again with the same method. */
export const FIT_NEXT = "Next: the outputs stay in the history. Raise the room with /auto-compact budget <tokens>, or keep no outputs with /auto-compact method summary.";

/**
 * The detail under the short line, one fact per line: the planner's cost, why it was mostly uncached, and the fit
 * arithmetic of a summary too large for the window with the next step. The row's title and body and
 * `/auto-compact status` show them.
 */
export function recordDetail(r: CompactRecord): string[] {
	const planner = plannerLine(r);
	const fit = fitReason(r);
	return [
		...(planner ? [planner] : []),
		...(mostlyUncached(r) ? [`planner mostly uncached: read ${Math.round((r.planner!.usage.cacheRead / r.planner!.promptTokens) * 100)}% from cache; ${onBridge(r) ? "expected on the claude/ subscription bridge (known gap); the API route reuses the cache" : "the request prefix changed or its cache expired before the planner ran"}`] : []),
		...(fit ? [fit, FIT_NEXT] : []),
	];
}

/** What the planning requests cost, or undefined when the record has none. */
export function plannerLine(r: CompactRecord): string | undefined {
	const p = r.planner;
	if (!p) return undefined;
	return `planner ${p.model} · ${p.requests} request${p.requests === 1 ? "" : "s"} · ${k(p.usage.output)} out / ${k(p.promptTokens)} in · ${p.cache}`;
}
