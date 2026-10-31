import { useState } from "react";
import type { HerdrLayout, ThreadSummary, ThreadsState } from "../../../src/shared/protocol.ts";
import { PiHostSection } from "./PiSidebar.tsx";
import { isPiHost } from "./host-label.ts";
import { type HostState, hub, useNow, useTopic } from "../client.ts";
import { type LinkView, linkView } from "./host-fold.ts";
import { hasRealModel, useModels } from "../models.ts";
import { openAccounts } from "./Accounts.tsx";
import { ACTIVITY_LABEL, MOD, ago, attentionOf, go, goTerm, href, isBusy } from "../util.ts";
import { PAGES } from "../views/registry.ts";
import { dispatchKeyAction } from "../keymap.ts";
import { handleSidebarKeyDown } from "./sidebar-keys.ts";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "../theme.ts";
import { PinMenu, PinnedSection, openPinMenu } from "./Pinned.tsx";
import { Segmented } from "./Segmented.tsx";

/** `error`: why the Host ended or holds this list (pending or end frame); an ended list never loads further. */
export type HostThreads = { host: HostState; threads: ThreadSummary[]; stale: boolean; layout?: HerdrLayout; error?: string } & Pick<ThreadsState, "indexing" | "listing" | "updating">;

/** A Host link's last failure and next step. Each view shows both while the Host is not connected, so a retry keeps the reason. */
export function LinkNotes({ view }: { view: LinkView }) {
	return <>
		{view.error && <div className="host-note err" data-link-error>{view.error}</div>}
		{view.hint && <div className="host-note" data-link-hint>{view.hint}</div>}
	</>;
}

export function ActivityIcon({ t }: { t: ThreadSummary }) {
	if (isBusy(t)) return <span className="spinner" title={ACTIVITY_LABEL[t.activity]} />;
	return null;
}

export function ThreadBadges({ t, compact = false, hideTeam = false }: { t: ThreadSummary; compact?: boolean; hideTeam?: boolean }) {
	const attention = attentionOf(t);
	if (compact) return <>
		{t.queued > 0 && <span className="row-meta" title={`${t.queued.toLocaleString()} queued`}>{t.queued.toLocaleString()} ↵</span>}
		{!hideTeam && t.team?.role === "lead" && <span className="row-meta">team</span>}
	</>;
	return (
		<>
			{/* A closed thread never needs the owner (attentionOf); its kept reason shows in the Closed feedback. */}
			{attention.filter((a) => a.source !== "error").slice(0, 1).map((a) => (
				<span key={a.reason} className="badge attn" title={`${a.source}: ${a.reason}`}>
					◆! {a.reason}
				</span>
			))}
			{!t.closed && t.lastError && (
				<span className="badge err" title={t.lastError}>
					× error
				</span>
			)}
			{t.queued > 0 && <span className="badge">{t.queued} queued</span>}
			{attention.length === 0 && t.team?.role === "lead" && <span className="badge accent">team</span>}
		</>
	);
}

export { isPiHost };

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

/** Node-owned terminals of one host, listed under its threads. */
function HostTerms({ host, route }: { host: HostState; route: { host?: string; term?: string } }) {
	// biome-ignore lint: loosely typed terminal list
	const { value } = useTopic(host.link, { kind: "terms" });
	const terms = Object.values(value?.terms ?? {}) as { id: string; title: string; exited?: number; createdAt: number }[];
	return (
		<>
			{terms
				.sort((a, b) => a.createdAt - b.createdAt)
				.map((t) => (
					<div key={t.id} className={`row term-row ${route.host === host.link && route.term === t.id ? "active" : ""}`} onClick={() => goTerm(host.link, t.id)} data-term-row={t.id} data-nav-row tabIndex={route.host === host.link && route.term === t.id ? 0 : -1} aria-current={route.host === host.link && route.term === t.id ? "page" : undefined}>
						<span className="twisty">›_</span>
						<span className="title">{t.title}</span>
						{t.exited !== undefined && <span className="badge">exited</span>}
					</div>
				))}
		</>
	);
}

export async function openTerminal(host: string, cwd?: string): Promise<void> {
	const term = await hub.request(host, "term.open", { cwd, cols: 120, rows: 32 });
	goTerm(host, term.id);
}

function HostSection({
	data,
	route,
	showArchived,
}: {
	data: HostThreads;
	route: { host?: string; thread?: string; term?: string; page?: string };
	showArchived: boolean;
}) {
	const { host, threads } = data;
	const [collapsed, setCollapsed] = useState(false);
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const real = hasRealModel(useModels(host.link, host.status === "connected"));
	const byParent = new Map<string, ThreadSummary[]>();
	for (const t of threads) {
		if (!t.parentId) continue;
		const list = byParent.get(t.parentId) ?? [];
		list.push(t);
		byParent.set(t.parentId, list);
	}
	const roots = threads
		.filter((t) => !t.parentId || !threads.some((p) => p.id === t.parentId))
		.filter((t) => showArchived || !t.archived)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const now = useNow(host.status !== "connected");
	const view = linkView(host, now);
	const status =
		host.status === "connected"
			? `${host.node?.hostname ?? ""}${host.latencyMs !== undefined && host.kind === "ssh" ? ` · ${host.latencyMs}ms` : ""}`
			: view.state;
	return (
		<div className="side-section" data-host={host.id}>
			<div className="side-head" onClick={() => setCollapsed(!collapsed)} style={{ cursor: "pointer" }}>
				<span className={`dot ${host.status}`} />
				<span className="grow">{host.label}</span>
				{host.status === "connected" && (
					<span
						className="add"
						title="Models signed in on this host"
						onClick={(e) => {
							e.stopPropagation();
							openAccounts(host.link);
						}}
					>
						models
					</span>
				)}
				{host.status === "connected" && (
					<span
						className="add"
						title="New terminal on this host"
						onClick={(e) => {
							e.stopPropagation();
							void openTerminal(host.link).catch((error) => alert((error as Error).message));
						}}
					>
						›_ +
					</span>
				)}
				<span className="meta">{status}</span>
			</div>
			<LinkNotes view={view} />
			{host.status === "connected" && real === false && (
				<div className="host-note warn" data-no-model={host.id}>
					No model is signed in here, so threads use the offline simulator.{" "}
					<a
						href="#"
						onClick={(e) => {
							e.preventDefault();
							openAccounts(host.link);
						}}
					>
						Set up models
					</a>
				</div>
			)}
			{host.status === "connected" && host.buildMismatch && (
				<div className="host-note warn" data-build-mismatch={host.id}>
					This node runs a different AmPi build ({host.node?.build ?? "unknown"}).{" "}
					<a
						href="#"
						onClick={(e) => {
							e.preventDefault();
							void hub.request(host.link, "node.restart").catch((error) => alert((error as Error).message));
						}}
					>
						Restart it
					</a>{" "}
					— running work resumes.
				</div>
			)}
			{!collapsed &&
				roots.map((t) => {
					const children = (byParent.get(t.id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
					const isOpen = open[t.id] ?? (route.thread !== undefined && (route.thread === t.id || children.some((c) => c.id === route.thread)));
					return (
						<div key={t.id}>
							<ThreadRow
								t={t}
								host={host.link}
								active={route.host === host.link && route.thread === t.id}
								hasChildren={children.length > 0}
								open={isOpen}
								toggle={() => setOpen({ ...open, [t.id]: !isOpen })}
							/>
							{isOpen &&
								children.map((c) => (
									<ThreadRow key={c.id} t={c} host={host.link} child navParentId={c.parentId ?? t.id} active={route.host === host.link && route.thread === c.id} />
								))}
						</div>
					);
				})}
			{!collapsed && roots.length === 0 && host.status === "connected" && <div className="host-note">No threads yet.</div>}
			{!collapsed && host.status === "connected" && <HostTerms host={host} route={route} />}
		</div>
	);
}

export function Sidebar({
	data,
	route,
	hubConnected,
	onNew,
	onHostSetup,
	onToggle,
}: {
	data: HostThreads[];
	route: { host?: string; thread?: string; term?: string; page?: string };
	hubConnected: boolean;
	onNew: () => void;
	onHostSetup: () => void;
	onToggle: () => void;
}) {
	const [showArchived, setShowArchived] = useState(false);
	const activePage = route.page ?? (!route.host ? (PAGES.some((p) => p.name === "timeline") ? "timeline" : "overview") : undefined);
	return (
		<aside className="side quiet-scroll" onKeyDown={(event) => handleSidebarKeyDown(event.nativeEvent, event.currentTarget)}>
			<div className="side-top">
				<div className="brand">
					<a href="#/" style={{ color: "inherit", textDecoration: "none" }}>
						AmPi
					</a>
					<span className={`dot hub-dot ${hubConnected ? "connected" : "disconnected"}`} title={hubConnected ? "Hub connected" : "Hub disconnected"} />
					<button className="btn ghost small" aria-label="Hide sidebar" title={`Hide sidebar (${MOD}B)`} onClick={onToggle}>☰</button>
				</div>
				<button className="btn ghost" onClick={onNew}>
					{data.length > 0 && data.every((d) => isPiHost(d.host)) ? "+ New agent" : "+ New thread"} <span className="kbd">{MOD}N</span>
				</button>
				{/* One search entry: the ⌘K palette searches Session names or prose; the tree below never filters. */}
				<button className="search search-open" onClick={() => dispatchKeyAction("session.palette", new KeyboardEvent("keydown"))}>
					Search Sessions or prose… <span className="kbd">{MOD}K</span>
				</button>
				{!hubConnected && (
					<div className="hint" data-hub-disconnected>
						Not connected to the hub. If it is running, open the link that <code>ampi open</code> prints: it carries this machine's access key.
					</div>
				)}
			</div>
			<div className="side-scroll quiet-scroll">
				{[...new Set(PAGES.map((p) => p.section))].map((section, i) => (
					<div key={section} className="nav-section" data-nav-section={section}>
						<div className="nav-label">{section}</div>
						{/* Overview leads the first section (Chief of Staff): it is the fleet's front page. ⌘0 still opens it. */}
						{i === 0 && (
							<a className={`row nav-row ${activePage === "overview" ? "active" : ""}`} href={href.page("overview")} data-nav-row tabIndex={activePage === "overview" ? 0 : -1} data-nav-page="overview" aria-current={activePage === "overview" ? "page" : undefined} title={`Overview (${MOD}0)`}>
								<span className="title">Overview</span>
							</a>
						)}
						{PAGES.filter((p) => p.section === section).map((p) => (
							<a key={p.name} className={`row nav-row ${activePage === p.name ? "active" : ""}`} href={href.page(p.name)} data-nav-row tabIndex={activePage === p.name ? 0 : -1} data-nav-page={p.name} aria-current={activePage === p.name ? "page" : undefined} title={p.label}>
								<span className="title">{p.label}</span>
							</a>
						))}
					</div>
				))}
				<PinnedSection data={data} />
				{data.map((d) =>
					isPiHost(d.host) ? (
						<PiHostSection key={d.host.link} data={d} route={route} />
					) : (
						<HostSection key={d.host.link} data={d} route={route} showArchived={showArchived} />
					),
				)}
				<div className="side-footer">
					<button className="btn ghost small" title="How to add a remote host: a prompt for your coding agent" onClick={onHostSetup}>
						Remote host (?)
					</button>
					<button className="btn ghost small" onClick={() => setShowArchived(!showArchived)}>
						{showArchived ? "Hide archived" : "Show archived"}
					</button>
					<button className="btn ghost small" title="Keys and help (?)" onClick={() => dispatchKeyAction("help", new KeyboardEvent("keydown"))}>
						?
					</button>
					<ThemeToggle />
				</div>
			</div>
			<PinMenu />
		</aside>
	);
}

const THEMES: [ThemeChoice, string][] = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];

/** System · Light · Dark. The choice persists in this browser; System follows the OS. */
function ThemeToggle() {
	const choice = useThemeChoice();
	return <Segmented className="theme-toggle" label="Theme" value={choice} options={THEMES} onChange={setThemeChoice} />;
}
