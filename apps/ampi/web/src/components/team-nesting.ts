import type { ThreadSummary } from "../../../src/shared/protocol.ts";

/** Nests each Team's workers under its lead when both are in the list; others keep their order. */
export function nestTeams(rows: ThreadSummary[]): { row: ThreadSummary; children: ThreadSummary[] }[] {
	const leads = new Map<string, { row: ThreadSummary; children: ThreadSummary[] }>();
	const out: { row: ThreadSummary; children: ThreadSummary[] }[] = [];
	for (const row of rows) {
		if (row.team?.role === "lead") {
			const item = { row, children: [] as ThreadSummary[] };
			leads.set(row.team.teamId, item);
			out.push(item);
		}
	}
	for (const row of rows) {
		if (row.team?.role === "lead") continue;
		const lead = row.team ? leads.get(row.team.teamId) : undefined;
		if (lead) lead.children.push(row);
		else out.push({ row, children: [] });
	}
	const position = new Map(rows.map((row, i) => [row, i]));
	return out.sort((a, b) => position.get(a.row)! - position.get(b.row)!);
}

export function projectTeamRows(rows: ThreadSummary[], collapsed: Set<string>) {
	return nestTeams(rows).flatMap(({ row, children }) => {
		const leaderId = row.team?.teamId ?? row.id;
		const isLeader = row.team?.role === "lead" && children.length > 0;
		const closed = isLeader && collapsed.has(leaderId);
		return [
			{ row, child: false, hasChildren: isLeader, open: !closed, count: children.length, leaderId },
			...(closed ? [] : children.map((row) => ({ row, child: true, hasChildren: false, open: true, count: 0, leaderId }))),
		];
	});
}
