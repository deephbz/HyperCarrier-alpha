import { DURABLE_RELEASE, type HerdrLayout, type ThreadSummary, type ThreadsState } from "../../../src/shared/protocol.ts";
import { PiHostSection } from "./PiSidebar.tsx";
import { type HostState, useHosts, useSkippedHosts } from "../client.ts";
import { MOD, href } from "../util.ts";
import { PAGES } from "../views/registry.ts";
import { dispatchKeyAction } from "../keymap.ts";
import { handleSidebarKeyDown } from "./sidebar-keys.ts";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "../theme.ts";
import { PinMenu, PinnedSection } from "./Pinned.tsx";
import { Segmented } from "./Segmented.tsx";
import { sidebarFooter } from "../extensions-ui.ts";

/**
 * `error`: why the Host ended or holds this list (pending or end frame); an ended list never loads further. The list
 * carries every other ThreadsState field as the Host sent it, so an augmented field reaches its view.
 */
export type HostThreads = { host: HostState; threads: ThreadSummary[]; stale: boolean; layout?: HerdrLayout; error?: string } & Omit<ThreadsState, "threads" | "layout" | "backend">;

/** Why the browser has no hub, and the owner's next step; the client reconnects by itself (client.ts). */
export function HubNotConnected() {
	return <>Not connected to the hub. If it is running, open the link that <code>ampi open</code> prints: it carries this machine's access key.</>;
}

/** One line for the hub.json rows this hub skips: their Hosts and threads need the durable release. */
function SkippedHosts() {
	const skipped = useSkippedHosts();
	if (!skipped.length) return null;
	return (
		<div className="host-note warn" data-skipped-hosts={skipped.map((host) => host.id).join(" ")}>
			Not shown: {skipped.map((host) => host.label).join(", ")}. {DURABLE_RELEASE}
		</div>
	);
}

/** ☰ for Show and Hide sidebar: a 16 px icon like the header's Find, so it matches the header icons in size and centre. */
export const SidebarIcon = () => (
	<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>
);

export function Sidebar({
	data,
	route,
	hubConnected,
	onNew,
	onHostSetup,
	onToggle,
}: {
	data: HostThreads[];
	route: { host?: string; thread?: string; page?: string };
	hubConnected: boolean;
	onNew: () => void;
	onHostSetup: () => void;
	onToggle: () => void;
}) {
	const activePage = route.page ?? (!route.host ? (PAGES.some((p) => p.name === "timeline") ? "timeline" : "overview") : undefined);
	return (
		<aside className="side quiet-scroll" onKeyDown={(event) => handleSidebarKeyDown(event.nativeEvent, event.currentTarget)}>
			<div className="side-top">
				<div className="brand">
					<a href="#/" style={{ color: "inherit", textDecoration: "none" }}>
						AmPi
					</a>
					<span className={`dot hub-dot ${hubConnected ? "connected" : "disconnected"}`} title={hubConnected ? "Hub connected" : "Hub disconnected"} />
					<button className="btn ghost small" aria-label="Hide sidebar" title={`Hide sidebar (${MOD}B)`} onClick={onToggle}><SidebarIcon /></button>
				</div>
				<button className="btn ghost" onClick={onNew}>
					+ New agent <span className="kbd">{MOD}N</span>
				</button>
				{/* One search entry: the ⌘K palette searches Session names or prose; the tree below never filters. */}
				<button className="search search-open" onClick={() => dispatchKeyAction("session.palette", new KeyboardEvent("keydown"))}>
					Search Sessions or prose… <span className="kbd">{MOD}K</span>
				</button>
				{!hubConnected && <div className="hint" data-hub-disconnected><HubNotConnected /></div>}
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
				{data.map((d) => <PiHostSection key={d.host.link} data={d} hosts={data.map((other) => other.host)} route={route} />)}
				<SkippedHosts />
				<div className="side-footer">
					<button className="btn ghost small" title="How to add a remote host: a prompt for your coding agent" onClick={onHostSetup}>
						Remote host (?)
					</button>
					{sidebarFooter.map((Footer, i) => <Footer key={i} data={data} />)}
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
