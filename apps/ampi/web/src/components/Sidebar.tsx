import { useState } from "react";
import type { HerdrLayout, ThreadSummary } from "../../../src/shared/protocol.ts";
import { PiHostSection } from "./PiSidebar.tsx";
import { type HostState, hub, useTopic } from "../client.ts";
import { hasRealModel, useModels } from "../models.ts";
import { openAccounts } from "./Accounts.tsx";
import { ACTIVITY_LABEL, MOD, ago, attentionOf, go, goTerm, href, isBusy } from "../util.ts";
import { FleetSearch } from "./Search.tsx";
import { PAGES } from "../views/registry.ts";
import { dispatchKeyAction } from "../keymap.ts";
import { handleSidebarKeyDown } from "./sidebar-keys.ts";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "../theme.ts";

export type HostThreads = { host: HostState; threads: ThreadSummary[]; stale: boolean; layout?: HerdrLayout };

export function ActivityIcon({ t }: { t: ThreadSummary }) {
	if (isBusy(t)) return <span className="spinner" title={ACTIVITY_LABEL[t.activity]} />;
	return null;
}

export function ThreadBadges({ t, compact = false }: { t: ThreadSummary; compact?: boolean }) {
	const attention = attentionOf(t);
	if (compact) return <>
		{attention.length > 0 && <span className={`badge ${t.lastError ? "err" : "attn"}`} role="img" aria-label="Needs you" title={attention.map((a) => `${a.source}: ${a.reason}`).join("\n")}>!</span>}
		{t.queued > 0 && <span className="row-meta" title={`${t.queued.toLocaleString()} queued`}>{t.queued.toLocaleString()} ↵</span>}
		{attention.length === 0 && t.team?.role === "lead" && <span className="row-meta">team</span>}
	</>;
	return (
		<>
			{t.rarebit?.status === "needs_attention" && t.rarebit.fresh && (
				<span className="badge attn" title={`Rarebit: needs you (${t.rarebit.reason ?? ""})`}>
					◆! {t.rarebit.reason ?? "needs you"}
				</span>
			)}
			{(t.attention ?? []).slice(0, 1).map((a) => (
				<span key={a.reason} className="badge attn" title={`${a.source}: ${(t.attention ?? []).map((x) => x.reason).join("; ")}`}>
					◆! {a.reason}
				</span>
			))}
			{t.lastError && (
				<span className="badge err" title={t.lastError}>
					× error
				</span>
			)}
			{t.queued > 0 && <span className="badge">{t.queued} queued</span>}
			{attention.length === 0 && t.team?.role === "lead" && <span className="badge accent">team</span>}
		</>
	);
}

export function isPiHost(host: HostState | undefined): boolean {
	return host?.kind === "pi-local" || host?.kind === "pi-ssh";
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
				if (hasChildren && toggle) toggle(); else go(host, t.id);
			}}
			title={`${t.title}\n${t.cwd}${t.model ? `\n${t.model}` : ""}`}
			data-thread={t.id}
			data-team-role={t.team?.role}
			data-parent-leader={child ? t.team?.teamId : undefined}
			data-row-level={child ? 2 : 1}
			data-leader-row={hasChildren ? t.team?.teamId : undefined}
		>
			{!child && (hasChildren && toggle ? (
				<button
					className="twisty"
					data-collapse-toggle={t.team?.teamId}
					tabIndex={-1}
					aria-label={`${open ? "Collapse" : "Expand"} ${t.title || "Untitled Session"}`}
					aria-expanded={open}
					onClick={(e) => {
						e.stopPropagation();
						toggle?.();
					}}
				>
					{hasChildren ? (open ? "▾" : "▸") : ""}
				</button>
			) : <span className="twisty" aria-hidden="true">{hasChildren ? "▾" : ""}</span>)}
			{/* Every row reserves the status-mark slot, so its text starts at the same x whatever the Session's state. */}
			<span className="mark-slot"><ActivityIcon t={t} /></span>
			<a className="title" href={href.thread(host, t.id)} aria-current={active ? "page" : undefined} data-nav-row tabIndex={active ? 0 : -1} aria-expanded={hasChildren ? open : undefined} data-team-role={t.team?.role} data-parent-leader={child ? t.team?.teamId : undefined} data-parent-nav-id={navParentId} data-nav-id={hasChildren && t.team?.role === "lead" ? t.team.teamId : t.id} data-row-level={child ? 2 : 1} data-leader-row={hasChildren ? t.team?.teamId : undefined} dir="auto">
				{t.team?.role === "worker" && t.team.worker ? <b>{t.team.worker}</b> : t.title || "Untitled Session"}
			</a>
			<ThreadBadges t={t} compact />
			{hasChildren && !open && <span className="badge worker-count" data-worker-count={t.team?.teamId}>{workerCount}</span>}
			<span className="sub">{ago(t.updatedAt)}</span>
		</div>
	);
}

/** Node-owned terminals of one host, listed under its threads. */
function HostTerms({ host, route }: { host: HostState; route: { host?: string; term?: string } }) {
	// biome-ignore lint: loosely typed terminal list
	const { value } = useTopic<any>(host.id, { kind: "terms" });
	const terms = Object.values(value?.terms ?? {}) as { id: string; title: string; exited?: number; createdAt: number }[];
	return (
		<>
			{terms
				.sort((a, b) => a.createdAt - b.createdAt)
				.map((t) => (
					<div key={t.id} className={`row term-row ${route.host === host.id && route.term === t.id ? "active" : ""}`} onClick={() => goTerm(host.id, t.id)} data-term-row={t.id} data-nav-row tabIndex={route.host === host.id && route.term === t.id ? 0 : -1} aria-current={route.host === host.id && route.term === t.id ? "page" : undefined}>
						<span className="twisty">›_</span>
						<span className="title">{t.title}</span>
						{t.exited !== undefined && <span className="badge">exited</span>}
					</div>
				))}
		</>
	);
}

export async function openTerminal(host: string, cwd?: string): Promise<void> {
	const term = await hub.request<{ id: string }>(host, "term.open", { cwd, cols: 120, rows: 32 });
	goTerm(host, term.id);
}

function HostSection({
	data,
	route,
	filter,
	showArchived,
}: {
	data: HostThreads;
	route: { host?: string; thread?: string; term?: string; page?: string };
	filter: string;
	showArchived: boolean;
}) {
	const { host, threads } = data;
	const [collapsed, setCollapsed] = useState(false);
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const real = hasRealModel(useModels(host.id, host.status === "connected"));
	const q = filter.toLowerCase();
	const match = (t: ThreadSummary) =>
		!q || t.title.toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q) || (t.preview ?? "").toLowerCase().includes(q);
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
		.filter((t) => match(t) || (byParent.get(t.id) ?? []).some(match))
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const status =
		host.status === "connected"
			? `${host.node?.hostname ?? ""}${host.latencyMs !== undefined && host.kind === "ssh" ? ` · ${host.latencyMs}ms` : ""}`
			: host.status === "connecting"
				? "connecting…"
				: `disconnected${host.lastSeen ? ` · last seen ${ago(host.lastSeen)} ago` : ""}`;
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
							openAccounts(host.id);
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
							void openTerminal(host.id).catch((error) => alert((error as Error).message));
						}}
					>
						›_ +
					</span>
				)}
				<span className="meta">{status}</span>
			</div>
			{host.status === "disconnected" && host.error && <div className="host-note err">{host.error}</div>}
			{host.status === "connected" && real === false && (
				<div className="host-note warn" data-no-model={host.id}>
					No model is signed in here, so threads use the offline simulator.{" "}
					<a
						href="#"
						onClick={(e) => {
							e.preventDefault();
							openAccounts(host.id);
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
							void hub.request(host.id, "node.restart").catch((error) => alert((error as Error).message));
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
								host={host.id}
								active={route.host === host.id && route.thread === t.id}
								hasChildren={children.length > 0}
								open={isOpen}
								toggle={() => setOpen({ ...open, [t.id]: !isOpen })}
							/>
							{isOpen &&
								children.map((c) => (
									<ThreadRow key={c.id} t={c} host={host.id} child navParentId={c.parentId ?? t.id} active={route.host === host.id && route.thread === c.id} />
								))}
						</div>
					);
				})}
			{!collapsed && roots.length === 0 && host.status === "connected" && <div className="host-note">No threads{q ? " match" : " yet"}.</div>}
			{!collapsed && host.status === "connected" && <HostTerms host={host} route={route} />}
		</div>
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
	route: { host?: string; thread?: string; term?: string; page?: string };
	hubConnected: boolean;
	onNew: () => void;
	onAddHost: () => void;
	onToggle: () => void;
}) {
	const [filter, setFilter] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const activePage = route.page ?? (!route.host ? (PAGES.some((p) => p.name === "timeline") ? "timeline" : "overview") : undefined);
	return (
		<aside className="side" onKeyDown={(event) => handleSidebarKeyDown(event.nativeEvent, event.currentTarget)}>
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
				<input className="search" aria-label="Filter Sessions" placeholder="Filter Sessions…" value={filter} onChange={(e) => setFilter(e.target.value)} />
				{!hubConnected && (
					<div className="hint" data-hub-disconnected>
						Not connected to the hub. If it is running, open the link that <code>ampi open</code> prints: it carries this machine's access key.
					</div>
				)}
			</div>
			<div className="side-scroll">
				{data.some((d) => isPiHost(d.host)) && <FleetSearch hosts={data.filter((d) => isPiHost(d.host)).map((d) => d.host)} />}
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
				{data.map((d) =>
					isPiHost(d.host) ? (
						<PiHostSection key={d.host.id} data={d} route={route} filter={filter} />
					) : (
						<HostSection key={d.host.id} data={d} route={route} filter={filter} showArchived={showArchived} />
					),
				)}
				<div className="side-footer">
					<button className="btn ghost small" onClick={onAddHost}>
						+ Add host
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
