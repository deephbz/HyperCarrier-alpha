import type { SearchResult } from "../../../src/pi/search.ts";

/** One Host's answer to `sessions.search`: its hits, or why it was not searched. */
export type HostProse = { host: { link: string; label: string; status?: string }; value?: SearchResult; error?: string };
export type ProseRow = { host: string; hostLabel: string; threadId: string; entry: string; title: string; snippet: string };

/** Flattens per-Host prose results into palette rows in Host order; a failed, away, partly indexed or truncated Host becomes a note. `scope` is the hub's own statement of what prose search covers. */
export function proseRows(results: HostProse[]): { rows: ProseRow[]; notes: string[]; scope?: string } {
	const rows: ProseRow[] = [];
	const notes: string[] = [];
	for (const { host, value, error } of results) {
		if (error) notes.push(`${host.label} not searched: ${error}`);
		if (!value) continue;
		if (host.status && host.status !== "connected") notes.push(`${host.label}: Host away; searched its last copy`);
		const updating = value.coverage?.updating;
		if (updating) notes.push(`${host.label}: searching ${value.coverage!.indexed} of ${value.coverage!.indexed + updating} Sessions — updating after upgrade`);
		const gaps = value.coverage && [
			value.coverage.notIndexed && `${value.coverage.notIndexed} copies not indexed`,
			value.coverage.stale && `${value.coverage.stale} behind source or unavailable`,
			value.coverage.invalidLines && `${value.coverage.invalidLines} invalid records excluded`,
		].filter(Boolean);
		if (gaps?.length) notes.push(`${host.label}: ${gaps.join(" · ")}`);
		if (value.more) notes.push(`${host.label}: limit reached; narrow the query`);
		for (const hit of value.hits) rows.push({ host: host.link, hostLabel: host.label, threadId: hit.threadId, entry: hit.entry, title: hit.title || "Untitled Session", snippet: hit.snippet });
	}
	return { rows, notes, scope: results.find((result) => result.value)?.value?.scope };
}
