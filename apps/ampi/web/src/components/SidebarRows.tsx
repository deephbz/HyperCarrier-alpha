// The rows and Host notes that every sidebar section draws: `ThreadRow` and `LinkNotes`.
// Sidebar.tsx and PiSidebar.tsx both compose them, so this module imports neither.

import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import type { LinkView } from "./host-fold.ts";
import { ago, go, href } from "../util.ts";
import { openPinMenu } from "./Pinned.tsx";
import { ActivityIcon, ThreadBadges } from "./ThreadStatus.tsx";

/** A Host link's last failure and next step. Each view shows both while the Host is not connected, so a retry keeps the reason. */
export function LinkNotes({ view }: { view: LinkView }) {
	return <>
		{view.error && <div className="host-note err" data-link-error>{view.error}</div>}
		{view.hint && <div className="host-note" data-link-hint>{view.hint}</div>}
	</>;
}

export function ThreadRow({
	t,
	host,
	active,
	child,
	hasChildren,
	open,
	toggle,
	workerCount,
	navParentId,
}: {
	t: ThreadSummary;
	host: string;
	active: boolean;
	child?: boolean;
	hasChildren?: boolean;
	open?: boolean;
	toggle?: () => void;
	workerCount?: number;
	navParentId?: string;
}) {
	return (
		<div
			className={`row ${active ? "active" : ""} ${child ? "child" : ""}`}
			onClick={(e) => {
				if ((e.target as HTMLElement).closest("a, button")) return;
				go(host, t.id);
			}}
			onContextMenu={(e) => openPinMenu(e, host, t.id, t.title)}
			title={`${t.title}\n${t.cwd}${t.model ? `\n${t.model}` : ""}`}
			data-thread={t.id}
			data-team-role={t.team?.role}
			data-parent-leader={child ? t.team?.teamId : undefined}
			data-row-level={child ? 2 : 1}
			data-leader-row={hasChildren ? t.team?.teamId : undefined}
		>
			{!child && <span className="twisty" aria-hidden="true" />}
			{/* Every row reserves the status-mark slot, so its text starts at the same x whatever the Session's state. */}
			<span className="mark-slot"><ActivityIcon t={t} /></span>
			<a className="title" href={href.thread(host, t.id)} aria-current={active ? "page" : undefined} data-nav-row tabIndex={active ? 0 : -1} aria-expanded={hasChildren ? open : undefined} data-team-role={t.team?.role} data-parent-leader={child ? t.team?.teamId : undefined} data-parent-nav-id={navParentId} data-nav-id={hasChildren && t.team?.role === "lead" ? t.team.teamId : t.id} data-row-level={child ? 2 : 1} data-leader-row={hasChildren ? t.team?.teamId : undefined} dir="auto">
				{t.team?.role === "worker" && t.team.worker ? t.team.worker : t.title || "Untitled Session"}
			</a>
			<ThreadBadges t={t} compact hideTeam={hasChildren} />
			{hasChildren && toggle && <button className="team-fold" data-collapse-toggle={t.team?.teamId} tabIndex={-1} aria-label={`${open ? "Collapse" : "Expand"} Workers for ${t.title || "Untitled Session"}`} aria-expanded={open} onClick={toggle}>
				<span className="twisty" aria-hidden="true">{open ? "▾" : "▸"}</span><span>team</span>
				{!open && <span className="badge worker-count" data-worker-count={t.team?.teamId}>{workerCount}</span>}
			</button>}
			<span className="sub">{ago(t.updatedAt)}</span>
		</div>
	);
}
