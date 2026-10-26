import { useState } from "react";
import type { HerdrLayout, ThreadSummary, ThreadsState } from "../../../src/shared/protocol.ts";
import { PiHostSection } from "./PiSidebar.tsx";
import { type HostState, hub, useTopic } from "../client.ts";
import { hasRealModel, useModels } from "../models.ts";
import { openAccounts } from "./Accounts.tsx";
import { ACTIVITY_LABEL, MOD, ago, attentionOf, go, href, isBusy } from "../util.ts";
import { FleetSearch } from "./Search.tsx";
import { PAGES } from "../views/registry.ts";
import { dispatchKeyAction } from "../keymap.ts";
import { handleSidebarKeyDown } from "./sidebar-keys.ts";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "../theme.ts";

/** `error`: why the Host ended or holds this list (pending or end frame); an ended list never loads further. */
export type HostThreads = { host: HostState; threads: ThreadSummary[]; stale: boolean; layout?: HerdrLayout; error?: string } & Pick<ThreadsState, "indexing" | "listing" | "updating">;

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
			{t.archived && <span className="badge">Archived</span>}
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

export { isPiHost } from "./host-label.ts";

/**
 * The Host source serves the Pi-shaped HostOps and reader views: Find, search, Rarebit, Arc, Timeline and history pages.
 * A Pi Host serves them itself; the hub serves them for a durable node from its reader copy (node-design.md, step 8).
 * Herdr-only behavior (new agent in Herdr, Resume, Close pane, a read-only composer) stays behind `isPiHost`.
 */
export function servesHostOps(host: HostState | undefined): boolean {
	return host?.kind === "pi-local" || host?.kind === "pi-ssh" || host?.kind === "local" || host?.kind === "ssh";
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

/**
 * A durable node's own notes: signed-in models, the offline simulator, and a node on another AmPi build.
 * A Pi Host has no node, so it shows none of them.
 */
export function NodeNotes({ host }: { host: HostState }) {
	const real = hasRealModel(useModels(host.link, host.status === "connected"));
	if (host.status !== "connected") return null;
	return (
		<>
			{real === false ? (
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
			) : null}
			{host.buildMismatch && (
				<div className="host-note warn" data-build-mismatch={host.id}>
					This node needs the new build ({host.node?.build ?? "unknown"}).{" "}
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
		</>
	);
}

export function Sidebar({
	data,
	route,
	hubConnected,
	onNew,
	onAddHost,
	onToggle,
}: {
	data: HostThreads[];
	route: { host?: string; thread?: string; page?: string };
	hubConnected: boolean;
	onNew: () => void;
	onAddHost: () => void;
	onToggle: () => void;
}) {
	const [filter, setFilter] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const archivedCount = data.reduce((count, host) => count + host.threads.filter((thread) => thread.archived).length, 0);
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
					+ New agent <span className="kbd">{MOD}N</span>
				</button>
				<input className="search" aria-label="Filter Sessions" placeholder="Filter Sessions…" value={filter} onChange={(e) => setFilter(e.target.value)} />
				{!hubConnected && (
					<div className="hint" data-hub-disconnected>
						Not connected to the hub. If it is running, open the link that <code>ampi open</code> prints: it carries this machine's access key.
					</div>
				)}
			</div>
			<div className="side-scroll quiet-scroll">
				{data.some((d) => servesHostOps(d.host)) && <FleetSearch hosts={data.filter((d) => servesHostOps(d.host)).map((d) => d.host)} />}
				<a className={`row ${activePage === "overview" ? "active" : ""}`} href={href.page("overview")} data-nav-row tabIndex={activePage === "overview" ? 0 : -1} aria-current={activePage === "overview" ? "page" : undefined}>
					<span className="twisty">⌂</span>
					<span className="title">Overview</span>
					<span className="sub">{MOD}0</span>
				</a>
				{[...new Set(PAGES.map((p) => p.section))].map((section) => (
					<div key={section} className="nav-section" data-nav-section={section}>
						<div className="nav-label">{section}</div>
						{PAGES.filter((p) => p.section === section).map((p) => (
							<a key={p.name} className={`row nav-row ${activePage === p.name ? "active" : ""}`} href={href.page(p.name)} data-nav-row tabIndex={activePage === p.name ? 0 : -1} data-nav-page={p.name} aria-current={activePage === p.name ? "page" : undefined} title={p.label}>
								<span className="title">{p.label}</span>
							</a>
						))}
					</div>
				))}
				{data.map((d) => (
					<PiHostSection key={d.host.link} data={d} hosts={data.map((other) => other.host)} route={route} filter={filter} showArchived={showArchived} />
				))}
				<div className="side-footer">
					<button className="btn ghost small" onClick={onAddHost}>
						+ Add host
					</button>
					<button className="btn ghost small" onClick={() => setShowArchived(!showArchived)}>
						{showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
					</button>
					<button className="btn ghost small" title="Keys and help (?)" onClick={() => dispatchKeyAction("help", new KeyboardEvent("keydown"))}>
						?
					</button>
					<ThemeToggle />
				</div>
			</div>
		</aside>
	);
}

const THEMES: [ThemeChoice, string][] = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];

/** System · Light · Dark. The choice persists in this browser; System follows the OS. */
function ThemeToggle() {
	const choice = useThemeChoice();
	return (
		<div className="seg theme-toggle" role="group" aria-label="Theme">
			{THEMES.map(([value, label]) => (
				<button key={value} className={choice === value ? "on" : ""} aria-pressed={choice === value} onClick={() => setThemeChoice(value)}>
					{label}
				</button>
			))}
		</div>
	);
}
