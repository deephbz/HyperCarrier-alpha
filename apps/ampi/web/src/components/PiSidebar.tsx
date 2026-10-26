// The sidebar section of a Host source (D15): Sessions arranged the way Herdr arranges them (workspace → tab → pane),
// with a Team's lead and its workers as a thread and its subthreads. Herdr's layout is auxiliary data; the Session's
// identity is its Host plus its Session ID, so a Session without a pane still shows, under "Not in a pane". A durable
// Host names that group "Archived".
// A durable node sends the same layout: one workspace per tab, whose panes are the open thread IDs in tab order
// (node-design.md, "Tabs and placement").

import { useEffect, useState } from "react";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import type { HostState } from "../client.ts";
import { ago } from "../util.ts";
import { type HostThreads, isPiHost, NodeNotes, ThreadRow } from "./Sidebar.tsx";
import { hostMeta, readHostFold, saveHostFold } from "./host-fold.ts";
import { hostLabel } from "./host-label.ts";
import { arrangeByLayout } from "./sidebar-layout.ts";
import { projectTeamRows } from "./team-nesting.ts";

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

export function PiHostSection({ data, hosts, route, filter, showArchived }: { data: HostThreads; hosts: HostState[]; route: { host?: string; thread?: string }; filter: string; showArchived: boolean }) {
	const { host } = data;
	const pi = isPiHost(host);
	const label = hostLabel(host, hosts);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ unplaced: true });
	// The Host fold persists, so a Host that is away on purpose stays folded with its error across reloads.
	const [fold, setFold] = useState(() => readHostFold(host.id));
	// The owner's expanded Teams. Every other leader is collapsed, including a Team that starts after the page loads.
	const leadersKey = `ampi.sidebar.expandedLeaders.${host.id}`;
	const [expandedLeaders, setExpandedLeaders] = useState<Set<string>>(() => {
		try {
			const saved = localStorage.getItem(leadersKey);
			if (saved !== null) return new Set(JSON.parse(saved) as string[]);
		} catch { /* Use the collapsed default if storage is unavailable or invalid. */ }
		return new Set();
	});
	const saveLeaders = (next: Set<string>) => {
		try { localStorage.setItem(leadersKey, JSON.stringify([...next])); } catch { /* The Teams stay expanded for this page only. */ }
		return next;
	};
	const q = filter.toLowerCase();
	const match = (t: ThreadSummary) => !q || t.title.toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q) || (t.preview ?? "").toLowerCase().includes(q);
	const { groups, unplaced } = arrangeByLayout({ threads: data.threads.filter((t) => match(t) && (showArchived || !t.archived)), layout: data.layout });
	// No agents list since the Host connected: saved rows stay listed, unplaced and not live, under this note.
	const looking = data.listing && host.status !== "disconnected";
	// After a failed working-set init no copy is readable; host.error says why.
	const status =
		host.status === "connected" ? "live" : host.status === "connecting" ? "connecting…" : host.cacheFailed ? "unavailable" : `away${host.lastSeen ? ` · seen ${ago(host.lastSeen)} ago` : ""} · copies readable`;
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
		<div className="side-section" data-host={host.id} data-backend={pi ? "pi" : "durable"}>
			<div className="side-head">
				<button className="host-collapse" onClick={() => setFold(saveHostFold(host, !fold.collapsed))} aria-expanded={!fold.collapsed} title={label}>
					<span className={`dot ${host.status}`} />
					<span className="grow">{label}</span>
					<span className="meta">{hostMeta(host)}</span>
					{/* A folded Host keeps its error for screen readers only; unfolding shows it. */}
					{fold.collapsed && host.status === "disconnected" && host.error && <span className="visually-hidden">: {host.error}</span>}
				</button>
				{teamIds.length > 0 && <button className="host-collapse-all" data-host-collapse-all={host.id} onClick={collapseAll} aria-label={`${allCollapsed ? "Expand" : "Collapse"} all Teams for ${label}`} title={`${allCollapsed ? "Expand" : "Collapse"} all Teams`}>{allCollapsed ? "Expand all" : "Collapse all"}</button>}
			</div>
			{!fold.collapsed && !pi && <NodeNotes host={host} />}
			{!fold.collapsed && host.status === "disconnected" && <div className="host-note">{status}</div>}
			{!fold.collapsed && host.status === "disconnected" && host.error && <div className="host-note err">{host.error}</div>}
			{!fold.collapsed && looking && <div className="host-note" role="status" data-listing>Looking for live Sessions…</div>}
			{!fold.collapsed &&
				groups.map((g) => (
					<div key={g.key} data-group={g.key}>
						<button className="row group-row" onClick={() => toggle(g.key)} data-nav-row data-nav-id={g.key} tabIndex={-1} data-sidebar-toggle={g.key} aria-expanded={!collapsed[g.key]} title={g.label}>
							<span className="twisty">{collapsed[g.key] ? "▸" : "▾"}</span>
							<span className="title group-label">{g.label}</span>
						</button>
						{!collapsed[g.key] && <SessionRows list={g.rows} host={host.link} active={route.host === host.link ? route.thread : undefined} expandedLeaders={expandedLeaders} toggleLeader={toggleLeader} parentNavId={g.key} />}
					</div>
				))}
			{!fold.collapsed && unplaced.length > 0 && (
				<div data-group="unplaced">
					<button className="row group-row" onClick={() => toggle("unplaced")} data-nav-row data-nav-id="unplaced" tabIndex={-1} data-sidebar-toggle="unplaced" aria-expanded={!collapsed.unplaced}>
						<span className="twisty">{collapsed.unplaced ? "▸" : "▾"}</span>
						<span className="title group-label">{data.listing ? "Not placed yet" : pi ? "Not in a pane" : "Archived"} ({unplaced.length.toLocaleString()})</span>
					</button>
					{!collapsed.unplaced && <SessionRows list={unplaced} host={host.link} active={route.host === host.link ? route.thread : undefined} expandedLeaders={expandedLeaders} toggleLeader={toggleLeader} parentNavId="unplaced" />}
				</div>
			)}
			{!fold.collapsed && groups.length === 0 && unplaced.length === 0 && host.status === "connected" && (
				<div className="host-note">{data.stale || data.indexing ? (pi ? "Reading Pi Sessions…" : "Reading threads…") : q ? "No Sessions match. Try a title or directory." : pi ? "No Pi Sessions found. Start an agent to begin." : "No threads yet. Start a thread to begin."}</div>
			)}
		</div>
	);
}
