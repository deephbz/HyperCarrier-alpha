// Overview's tier-2 Needs you (D16): open Arc asks per kind, read from the thread index's `arc` head only. No tree,
// transcript, or model call. Node Sessions keep their Rarebit Summary signal (C4); this module covers Pi Sessions.

import type { ThreadSummary } from "../../../../src/shared/protocol.ts";
import { NEEDS_YOU_KINDS, type NeedsYouKind } from "../../../../src/pi/views/cos-arc-context.ts";

export const KIND_LABEL: Record<NeedsYouKind, string> = { decision: "Decisions", approval: "Approvals and permissions", input: "Input", blocker: "Blockers" };

type Row = { t: ThreadSummary };
export type AskRow<R extends Row> = { row: R; n: number; since: number | null; stale: boolean };

/** Sessions with open tier-2 asks, grouped by kind in NEEDS_YOU_KINDS order; each group oldest ask first, unknown age last. */
export function asksByKind<R extends Row>(rows: R[]): { kind: NeedsYouKind; rows: AskRow<R>[] }[] {
	return NEEDS_YOU_KINDS.flatMap((kind) => {
		const list = rows.flatMap((row) => {
			const ask = row.t.arc?.asks.find((a) => a.kind === kind);
			return ask && ask.n > 0 ? [{ row, n: ask.n, since: ask.since, stale: row.t.arc!.stale }] : [];
		});
		list.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
		return list.length ? [{ kind, rows: list }] : [];
	});
}

/** Tier-2 coverage of the Pi Sessions in view: what an empty or partial Needs you card can and cannot claim. */
export function arcCoverage(rows: Row[], weekAgo: number): { built: number; notBuilt: number; stale: number } {
	const pi = rows.filter((r) => r.t.ref && (r.t.live || r.t.updatedAt > weekAgo));
	return { built: pi.filter((r) => r.t.arc).length, notBuilt: pi.filter((r) => !r.t.arc).length, stale: pi.filter((r) => r.t.arc?.stale).length };
}

/** Why the card shows no tier-2 ask, or which Sessions it cannot speak for. Empty when there is nothing to qualify. */
export function coverageNote(c: { built: number; notBuilt: number; stale: number }, empty: boolean): string {
	const parts: string[] = [];
	if (empty) parts.push(c.built ? `No open asks in ${c.built.toLocaleString()} built Arc${c.built === 1 ? "" : "s"}.` : "No Arc is built yet.");
	if (c.notBuilt) parts.push(`${c.notBuilt.toLocaleString()} recent Session${c.notBuilt === 1 ? " has" : "s have"} no Arc. A running agent's Arc builds after its next stop; open Arcs to build the others.`);
	if (c.stale) parts.push(`${c.stale.toLocaleString()} Arc${c.stale === 1 ? " is" : "s are"} out of date, so ${c.stale === 1 ? "its" : "their"} asks may already be answered.`);
	return parts.join(" ");
}

/** Every tier-2 thread is done and nothing is open, on an Arc that covers the latest messages. */
export function arcFinished(t: ThreadSummary): boolean {
	return Boolean(t.arc && !t.arc.stale && t.arc.finished);
}
