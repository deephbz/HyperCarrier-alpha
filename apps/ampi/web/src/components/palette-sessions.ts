/** The ⌘K palette's Session search: a match ranks by where it starts in a Team, Worker or Session name, then by recency. */
type Thread = { title?: string; updatedAt: number; team?: { teamId: string; worker?: string } };

/** Ranked Sessions for `query`; an empty query lists the most recently updated Sessions. */
export function paletteSessions<H, T extends Thread>(data: readonly { host: H; threads: readonly T[] }[], query: string, limit = 30): { host: H; t: T }[] {
	const needle = query.trim().toLowerCase();
	const rank = (t: T) => [t.team?.teamId ?? "", t.team?.worker ?? "", t.title ?? ""].reduce((best, value) => {
		const lower = value.toLowerCase();
		const at = lower.indexOf(needle);
		if (at < 0) return best;
		return Math.min(best, at === 0 ? 0 : /[\s/_-]$/.test(lower[at - 1] ?? "") ? 1 : 2);
	}, needle ? 3 : 0);
	return data.flatMap((d) => d.threads.map((t) => ({ host: d.host, t, rank: rank(t) })))
		.filter((row) => row.rank < 3)
		.sort((a, b) => a.rank - b.rank || b.t.updatedAt - a.t.updatedAt)
		.slice(0, limit)
		.map(({ host, t }) => ({ host, t }));
}
