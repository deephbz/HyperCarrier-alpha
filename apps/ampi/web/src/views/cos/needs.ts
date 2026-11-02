// Overview reads only the Arc head. The receipt and its prose stay in the Session panel.
import type { ThreadSummary } from "../../../../src/shared/protocol.ts";
import { arcNeedsCount } from "../../util.ts";


type Row = { t: ThreadSummary };
export function arcNeedsRows<R extends Row>(rows: R[]): R[] {
	return rows.filter((row) => arcNeedsCount(row.t) > 0).sort((a, b) => {
		const age = (r: R) => { const at = r.t.arc?.oldestAt; return at ? Date.parse(at) : Infinity; };
		return age(a) - age(b);
	});
}

export function arcCoverage(rows: Row[], weekAgo: number): { built: number; notBuilt: number; stale: number } {
	const recent = rows.filter((r) => r.t.ref && (r.t.live || r.t.updatedAt > weekAgo));
	return { built: recent.filter((r) => r.t.arc).length, notBuilt: recent.filter((r) => !r.t.arc).length, stale: recent.filter((r) => r.t.arc?.stale).length };
}

export function coverageNote(c: { built: number; notBuilt: number; stale: number }, empty: boolean): string {
	const parts: string[] = [];
	if (empty) parts.push(c.built ? `Nothing needs you in ${c.built.toLocaleString()} built Arc${c.built === 1 ? "" : "s"}.` : "No Arc is built yet.");
	if (c.notBuilt) parts.push(`${c.notBuilt.toLocaleString()} recent Session${c.notBuilt === 1 ? " has" : "s have"} no Arc. Open its Session panel to build one.`);
	if (c.stale) parts.push(`${c.stale.toLocaleString()} Arc${c.stale === 1 ? " is" : "s are"} out of date. New messages may have answered the requests.`);
	return parts.join(" ");
}
