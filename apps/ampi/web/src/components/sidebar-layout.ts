// Herdr's workspace → tab → pane order as sidebar groups (PiSidebar.tsx). Another Host kind can send the same layout
// shape and name each row's pane itself (HostKindUi.sidebar.paneOf).

import type { HerdrLayout, ThreadSummary } from "../../../src/shared/protocol.ts";

export type Group = { key: string; label: string; rows: ThreadSummary[] };

const herdrPane = (t: ThreadSummary) => t.location?.pane;

/** Orders a Host's Sessions by Herdr's layout. Pure, so the sidebar's order is testable without a browser. */
export function arrangeByLayout(data: { threads: ThreadSummary[]; layout?: HerdrLayout }, paneOf: (t: ThreadSummary) => string | undefined = herdrPane): { groups: Group[]; unplaced: ThreadSummary[] } {
	const byPane = new Map<string, ThreadSummary[]>();
	const unplaced: ThreadSummary[] = [];
	for (const t of data.threads) {
		const pane = paneOf(t);
		if (!pane) {
			unplaced.push(t);
			continue;
		}
		const list = byPane.get(pane) ?? [];
		list.push(t);
		byPane.set(pane, list);
	}
	const groups: Group[] = [];
	const seen = new Set<string>();
	for (const w of data.layout?.workspaces ?? []) {
		for (const tab of w.tabs) {
			const rows: ThreadSummary[] = [];
			for (const pane of tab.panes) {
				for (const t of byPane.get(pane) ?? []) {
					rows.push(t);
					seen.add(t.id);
				}
			}
			if (rows.length) groups.push({ key: `${w.id}/${tab.id}`, label: groupLabel(w.label ?? w.id, tab.label ?? tab.id), rows });
		}
	}
	// A pane the layout does not list yet (a race between Herdr calls) still shows, grouped by its own labels.
	const rest = data.threads.filter((t) => paneOf(t) && !seen.has(t.id));
	for (const t of rest) {
		const key = `${t.location?.workspace}/${t.location?.tab}`;
		let group = groups.find((g) => g.key === key);
		if (!group) {
			group = { key, label: groupLabel(t.location?.workspaceLabel ?? t.location?.workspace, t.location?.tabLabel ?? t.location?.tab), rows: [] };
			groups.push(group);
		}
		group.rows.push(t);
	}
	unplaced.sort((a, b) => b.updatedAt - a.updatedAt);
	return { groups, unplaced };
}

/** A group reads "workspace › tab"; a tab that is its own workspace shows its label once. */
function groupLabel(workspace: string | undefined, tab: string | undefined): string {
	return [...new Set([workspace, tab].filter(Boolean))].join(" › ");
}
