// The sidebar section of a Pi Host (D15): Sessions arranged the way Herdr arranges them (workspace → tab → pane),
// with a Team's lead and its workers as a thread and its subthreads. Herdr's layout is auxiliary data; the Session's
// identity is its Host plus its Session ID, so a Session without a pane still shows, under "Not in a pane".

import { useEffect, useState } from "react";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { ago } from "../util.ts";
import { type HostThreads, ThreadRow } from "./Sidebar.tsx";
import { projectTeamRows } from "./team-nesting.ts";

type Group = { key: string; label: string; rows: ThreadSummary[] };

/** Orders a Host's Sessions by Herdr's layout. Pure, so the sidebar's order is testable without a browser. */
export function arrangeByLayout(data: Pick<HostThreads, "threads" | "layout">): { groups: Group[]; unplaced: ThreadSummary[] } {
	const byPane = new Map<string, ThreadSummary[]>();
	const unplaced: ThreadSummary[] = [];
	for (const t of data.threads) {
		const pane = t.location?.pane;
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
			if (rows.length) groups.push({ key: `${w.id}/${tab.id}`, label: [w.label ?? w.id, tab.label ?? tab.id].join(" › "), rows });
		}
	}
	// A pane the layout does not list yet (a race between Herdr calls) still shows, grouped by its own labels.
	const rest = data.threads.filter((t) => t.location?.pane && !seen.has(t.id));
	for (const t of rest) {
		const key = `${t.location!.workspace}/${t.location!.tab}`;
		let group = groups.find((g) => g.key === key);
		if (!group) {
			group = { key, label: [t.location!.workspaceLabel ?? t.location!.workspace, t.location!.tabLabel ?? t.location!.tab].filter(Boolean).join(" › "), rows: [] };
			groups.push(group);
		}
		group.rows.push(t);
	}
	unplaced.sort((a, b) => b.updatedAt - a.updatedAt);
	return { groups, unplaced };
}

/** A bounded page keeps a large Host cheap without dropping its Herdr order or Team nesting. */
function SessionRows({ list, host, active, expandedLeaders, toggleLeader, parentNavId }: { list: ThreadSummary[]; host: string; active?: string; expandedLeaders: Set<string>; toggleLeader: (id: string) => void; parentNavId: string }) {
	const rows = projectTeamRows(list, expandedLeaders);
	const activePage = Math.floor(Math.max(0, rows.findIndex(({ row }) => row.id === active)) / 80);
	const [page, setPage] = useState(activePage);
	useEffect(() => setPage(activePage), [active, activePage]);
	const start = Math.min(page * 80, Math.max(0, Math.ceil(rows.length / 80) - 1) * 80);
	return <>
		{rows.slice(start, start + 80).map(({ row, child, hasChildren, open, count, leaderId }) => <div key={row.id}>
			<ThreadRow t={row} host={host} active={active === row.id} child={child} hasChildren={hasChildren} open={open} toggle={hasChildren ? () => toggleLeader(leaderId) : undefined} workerCount={count} navParentId={child ? leaderId : parentNavId} />
		</div>)}
		{rows.length > 80 && <div className="list-page">
			<button className="btn ghost small" disabled={start === 0} onClick={() => setPage(Math.max(0, page - 1))} aria-label="Previous Sessions">←</button>
			<span className="hint">{start + 1}–{Math.min(start + 80, rows.length)} of {rows.length.toLocaleString()}</span>
			<button className="btn ghost small" disabled={start + 80 >= rows.length} onClick={() => setPage(page + 1)} aria-label="Next Sessions">→</button>
		</div>}
	</>;
}

export function PiHostSection({ data, route, filter }: { data: HostThreads; route: { host?: string; thread?: string }; filter: string }) {
	const { host } = data;
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ unplaced: true });
	// The owner's expanded Teams. Every other leader is collapsed, including a Team that starts after the page loads.
	const leadersKey = `ampi.sidebar.expandedLeaders.${host.id}`;
	const [expandedLeaders, setExpandedLeaders] = useState<Set<string>>(() => {
		try {
			const saved = localStorage.getItem(leadersKey);
			if (saved !== null) return new Set(JSON.parse(saved) as string[]);
		} catch { /* Use the collapsed default if storage is unavailable or invalid. */ }
		return new Set();
	});
	const saveLeaders = (next: Set<string>) => { localStorage.setItem(leadersKey, JSON.stringify([...next])); return next; };
	const q = filter.toLowerCase();
	const match = (t: ThreadSummary) => !q || t.title.toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q) || (t.preview ?? "").toLowerCase().includes(q);
	const { groups, unplaced } = arrangeByLayout({ threads: data.threads.filter(match), layout: data.layout });
	const status =
		host.status === "connected" ? "live" : host.status === "connecting" ? "connecting…" : `away${host.lastSeen ? ` · seen ${ago(host.lastSeen)} ago` : ""} · copies readable`;
	const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
	const toggleLeader = (id: string) => setExpandedLeaders((previous) => {
		const next = new Set(previous);
		if (next.has(id)) next.delete(id); else next.add(id);
		return saveLeaders(next);
	});
	const teamIds = [...new Set(data.threads.filter((t) => t.team?.role === "lead").map((t) => t.team!.teamId))];
	const allCollapsed = teamIds.length > 0 && teamIds.every((id) => !expandedLeaders.has(id));
	const collapseAll = () => setExpandedLeaders(saveLeaders(allCollapsed ? new Set(teamIds) : new Set()));
	return (
		<div className="side-section" data-host={host.id} data-backend="pi">
			<div className="side-head">
				<button className="host-collapse" onClick={() => toggle("host")} aria-expanded={!collapsed.host} title={host.label}>
					<span className={`dot ${host.status}`} />
					<span className="grow">{host.label}</span>
					{host.status === "connected" && <span className="meta">live</span>}
				</button>
				{teamIds.length > 0 && <button className="host-collapse-all" data-host-collapse-all={host.id} onClick={collapseAll} aria-label={`${allCollapsed ? "Expand" : "Collapse"} all Teams for ${host.label}`} title={`${allCollapsed ? "Expand" : "Collapse"} all Teams`}>{allCollapsed ? "Expand all" : "Collapse all"}</button>}
			</div>
			{host.status !== "connected" && <div className="host-note">{status}</div>}
			{host.status === "disconnected" && host.error && <div className="host-note err">{host.error}</div>}
			{!collapsed.host &&
				groups.map((g) => (
					<div key={g.key} data-group={g.key}>
						<button className="row group-row" onClick={() => toggle(g.key)} data-nav-row data-nav-id={g.key} tabIndex={-1} data-sidebar-toggle={g.key} aria-expanded={!collapsed[g.key]} title={g.label}>
							<span className="twisty">{collapsed[g.key] ? "▸" : "▾"}</span>
							<span className="title group-label">{g.label}</span>
						</button>
						{!collapsed[g.key] && <SessionRows list={g.rows} host={host.id} active={route.host === host.id ? route.thread : undefined} expandedLeaders={expandedLeaders} toggleLeader={toggleLeader} parentNavId={g.key} />}
					</div>
				))}
			{!collapsed.host && unplaced.length > 0 && (
				<div data-group="unplaced">
					<button className="row group-row" onClick={() => toggle("unplaced")} data-nav-row data-nav-id="unplaced" tabIndex={-1} data-sidebar-toggle="unplaced" aria-expanded={!collapsed.unplaced}>
						<span className="twisty">{collapsed.unplaced ? "▸" : "▾"}</span>
						<span className="title group-label">Not in a pane ({unplaced.length.toLocaleString()})</span>
					</button>
					{!collapsed.unplaced && <SessionRows list={unplaced} host={host.id} active={route.host === host.id ? route.thread : undefined} expandedLeaders={expandedLeaders} toggleLeader={toggleLeader} parentNavId="unplaced" />}
				</div>
			)}
			{!collapsed.host && groups.length === 0 && unplaced.length === 0 && host.status === "connected" && (
				<div className="host-note">{data.stale ? "Reading Pi Sessions…" : q ? "No Sessions match. Try a title or directory." : "No Pi Sessions found. Start an agent to begin."}</div>
			)}
		</div>
	);
}
