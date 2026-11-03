// The sidebar section of a Host source (D15): Sessions arranged the way Herdr arranges them (workspace → tab → pane),
// with a Team's lead and its workers as a thread and its subthreads. Herdr's layout is auxiliary data; the Session's
// identity is its Host plus its Session ID, so a Session without a pane still shows, under "Not in a pane". Another
// Host kind keeps this section and fills its sidebar slot (HostKindUi.sidebar in shell-slots.ts).

import { useEffect, useState } from "react";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { type HostState, useNow } from "../client.ts";
import { hostKind } from "../host-kinds.ts";
import { kindUi } from "../shell-slots.ts";
import type { HostThreads } from "./Sidebar.tsx";
import { LinkNotes, ThreadRow } from "./SidebarRows.tsx";
import { hostMeta, linkView, readHostFold, saveHostFold } from "./host-fold.ts";
import { hostLabel } from "./host-label.ts";
import { arrangeByLayout } from "./sidebar-layout.ts";
import { projectTeamRows } from "./team-nesting.ts";

/** The cache-health note for stale reads: the hub repaired them, so this reports a defect and its log, not an action. */
function staleReadsNote({ reopened, behind, refused }: NonNullable<HostThreads["host"]["staleReads"]>): string {
	const parts = [reopened && `${reopened} repaired by a reopen`, behind && `${behind} still behind after it`, refused && `${refused} refused in publish`].filter(Boolean);
	return `Stale cache reads: ${parts.join(", ")}. The hub log names each one.`;
}

/** Keep Herdr order and Team nesting while rendering every Session in the Host group. */
function SessionRows({ list, host, active, expandedLeaders, toggleLeader, parentNavId }: { list: ThreadSummary[]; host: string; active?: string; expandedLeaders: Set<string>; toggleLeader: (id: string) => void; parentNavId: string }) {
	const rows = projectTeamRows(list, expandedLeaders);
	return <>
		{rows.map(({ row, child, hasChildren, open, count, leaderId }) => <div key={row.id}>
			<ThreadRow t={row} host={host} active={active === row.id} child={child} hasChildren={hasChildren} open={open} toggle={hasChildren ? () => toggleLeader(leaderId) : undefined} workerCount={count} navParentId={child ? leaderId : parentNavId} />
		</div>)}
	</>;
}

/** The Sessions a Host still re-derives after a start (HostBase.upgrade). */
function upgradeNote({ updated, total }: { updated: number; total: number }): string {
	const left = total - updated;
	return `Updating ${left.toLocaleString()} ${left === 1 ? "Session" : "Sessions"} after upgrade`;
}

const allRows = (threads: ThreadSummary[]) => threads;

export function PiHostSection({ data, hosts, route }: { data: HostThreads; hosts: HostState[]; route: { host?: string; thread?: string } }) {
	const { host } = data;
	const kind = hostKind(host);
	const ui = kindUi(host).sidebar ?? {};
	const label = hostLabel(host, hosts);
	const Notes = ui.Notes;
	// A kind's useRows is a hook; one Host keeps one kind, so the call order is stable.
	const threads = (ui.useRows ?? allRows)(data.threads);
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
	const { groups, unplaced } = arrangeByLayout({ threads, layout: data.layout }, ui.paneOf);
	// No agents list since the Host connected: saved rows stay listed, unplaced and not live, under this note.
	const looking = data.listing && host.status !== "disconnected";
	// After a failed working-set init no copy is readable; host.error says why.
	const now = useNow(host.status !== "connected");
	const view = linkView(host, now);
	const status = host.cacheFailed ? "unavailable" : `${view.state} · copies readable`;
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
		<div className="side-section" data-host={host.id} data-backend={kind.source}>
			<div className="side-head">
				<button className="host-collapse" onClick={() => setFold(saveHostFold(host, !fold.collapsed))} aria-expanded={!fold.collapsed} title={label}>
					<span className={`dot ${host.status}`} />
					<span className="grow">{label}</span>
					{host.status === "connected" ? <span className="visually-hidden">connected</span> : <span className="meta">{hostMeta(host, now)}</span>}
					{/* A folded Host keeps its error for screen readers only; unfolding shows it. */}
					{fold.collapsed && view.error && <span className="visually-hidden">: {view.error}</span>}
				</button>
				{teamIds.length > 0 && <button className="host-collapse-all" data-host-collapse-all={host.id} onClick={collapseAll} aria-label={`${allCollapsed ? "Expand" : "Collapse"} all Teams for ${label}`} title={`${allCollapsed ? "Expand" : "Collapse"} all Teams`}>{allCollapsed ? "Expand all" : "Collapse all"}</button>}
			</div>
			{!fold.collapsed && Notes && <Notes host={host} />}
			{!fold.collapsed && host.status === "disconnected" && <div className="host-note">{status}</div>}
			{!fold.collapsed && <LinkNotes view={view} />}
			{/* Cache health, apart from the link: a connected Host keeps its green dot. */}
			{!fold.collapsed && host.indexError && <div className="host-note warn" data-index-error={host.id}>Index not saved: {host.indexError}</div>}
			{!fold.collapsed && host.cacheFault && <div className="host-note warn" data-cache-fault={host.id}>Cache fault: {host.cacheFault}. Restart the hub if it lasts.</div>}
			{!fold.collapsed && host.staleReads && <div className="host-note warn" data-stale-reads={host.id}>{staleReadsNote(host.staleReads)}</div>}
			{!fold.collapsed && host.upgrade && <div className="host-note" role="status" data-upgrade={host.id}>{upgradeNote(host.upgrade)}</div>}
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
						<span className="title group-label">{data.listing ? "Not placed yet" : (ui.unplacedLabel ?? "Not in a pane")} ({unplaced.length.toLocaleString()})</span>
					</button>
					{!collapsed.unplaced && <SessionRows list={unplaced} host={host.link} active={route.host === host.link ? route.thread : undefined} expandedLeaders={expandedLeaders} toggleLeader={toggleLeader} parentNavId="unplaced" />}
				</div>
			)}
			{!fold.collapsed && groups.length === 0 && unplaced.length === 0 && host.status === "connected" && (
				<div className="host-note">{data.stale || data.indexing ? (ui.readingNote ?? "Reading Pi Sessions…") : (ui.emptyNote ?? "No Pi Sessions found. Start an agent to begin.")}</div>
			)}
		</div>
	);
}
