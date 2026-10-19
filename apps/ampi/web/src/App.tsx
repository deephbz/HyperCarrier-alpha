import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { ThreadsState, ThreadSummary } from "../../src/shared/protocol.ts";
import { type HostState, useHosts, useTopic } from "./client.ts";
import { AccountsDialog } from "./components/Accounts.tsx";
import { AddHostDialog, CommandPalette, DisplayDialog, HelpDialog, NewThreadDialog, Palette } from "./components/Dialogs.tsx";
import { useModels } from "./models.ts";
import { Overview } from "./components/Overview.tsx";
import { NewAgentDialog } from "./components/PiDialogs.tsx";
import { PiPanel, piPanels } from "./views/PiPanel.tsx";
import { PAGES } from "./views/registry.ts";
import { Panel } from "./components/Panel.tsx";
import { type HostThreads, Sidebar, isPiHost } from "./components/Sidebar.tsx";
import { type ModelChoice, ThreadView } from "./components/ThreadView.tsx";
// xterm is most of the bundle; it loads the first time a terminal is shown.
const TerminalView = lazy(() => import("./components/TerminalView.tsx").then((m) => ({ default: m.TerminalView })));
import { openTerminal } from "./components/Sidebar.tsx";
import { hashRoute, href, MOD } from "./util.ts";
import { FeedsContext } from "./context.ts";
import { requestNotificationPermission, useAttention } from "./attention.ts";
import { perfMarkPainted } from "./perf.ts";
import { focusRegion, handleRegionScrollKey, installKeymapDispatcher, regionToggle, useKeyAction } from "./keymap.ts";
import { toggleArcPanel } from "./views/cos/ArcPanel.tsx";

function savedWidth(key: string, fallback: number, min: number, max: number) {
	const value = Number(localStorage.getItem(key) ?? fallback);
	return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

/** Drag updates only the grid, not every Session component. Commit the preference when capture ends. */
function ResizeEdge({ side, width, onChange }: { side: "sidebar" | "panel"; width: number; onChange: (width: number) => void }) {
	const drag = useRef<number | undefined>(undefined);
	const min = side === "sidebar" ? 220 : 320;
	const max = side === "sidebar" ? 420 : 720;
	const clamp = (value: number) => Math.max(min, Math.min(max, value));
	return <div
		className={`resize-edge ${side}-edge`}
		role="separator"
		aria-label={side === "sidebar" ? "Sidebar width" : "Side panel width"}
		aria-orientation="vertical"
		aria-valuemin={min}
		aria-valuemax={max}
		aria-valuenow={width}
		tabIndex={0}
		onKeyDown={(e) => {
			const direction = side === "sidebar" ? 1 : -1;
			const step = e.shiftKey ? 32 : 8;
			const next = e.key === "Home" ? min : e.key === "End" ? max : e.key === "ArrowLeft" ? width - step * direction : e.key === "ArrowRight" ? width + step * direction : undefined;
			if (next !== undefined) { e.preventDefault(); onChange(clamp(next)); }
		}}
		onPointerDown={(e) => {
			if (e.button !== 0 || !e.isPrimary || drag.current !== undefined) return;
			e.preventDefault();
			e.currentTarget.focus();
			drag.current = width;
			e.currentTarget.setPointerCapture(e.pointerId);
		}}
		onPointerMove={(e) => {
			if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
			const app = e.currentTarget.closest<HTMLElement>(".app")!;
			const rect = app.getBoundingClientRect();
			const next = clamp(side === "sidebar" ? e.clientX - rect.left : rect.right - e.clientX);
			drag.current = next;
			app.style.setProperty(side === "sidebar" ? "--side-w" : "--panel-w", `${next}px`);
			e.currentTarget.setAttribute("aria-valuenow", String(next));
			const style = getComputedStyle(app);
			app.classList.toggle("panel-overlay", rect.width - parseFloat(style.getPropertyValue("--side-visible")) - parseFloat(style.getPropertyValue("--panel-w")) < 480);
		}}
		onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
		onLostPointerCapture={() => {
			if (drag.current !== undefined) onChange(drag.current);
			drag.current = undefined;
		}}
	/>;
}

/** Subscribes to one host's thread index and reports it upward (hooks cannot loop over a dynamic host list). */
function HostFeed({ host, onData }: { host: HostState; onData: (id: string, data: HostThreads) => void }) {
	const { value, stale } = useTopic<ThreadsState>(host.id, { kind: "threads" });
	useEffect(() => {
		onData(host.id, { host, threads: Object.values(value?.threads ?? {}) as ThreadSummary[], stale, ...(value?.layout ? { layout: value.layout } : {}) });
	}, [host, value, stale, onData]);
	return null;
}

function useRoute() {
	return useSyncExternalStore(
		(listener) => {
			window.addEventListener("hashchange", listener);
			return () => window.removeEventListener("hashchange", listener);
		},
		() => location.hash,
	);
}

export function App() {
	const { hosts, connected } = useHosts();
	const hash = useRoute();
	const route = hashRoute();
	const [feeds, setFeeds] = useState<Record<string, HostThreads>>({});
	const [dialog, setDialog] = useState<"new" | "host" | "palette" | "commands" | "display" | "help" | undefined>();
	const [panel, setPanel] = useState<string | undefined>(() => localStorage.getItem("ampi.panel") ?? undefined);
	const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem("ampi.sidebar.hidden") === "1");
	const [sidebarPeek, setSidebarPeek] = useState(false);
	const squeezedRef = useRef(false);
	const overlayRef = useRef(false);
	const [sidebarWidth, setSidebarWidth] = useState(() => savedWidth("ampi.sidebar.width", 280, 220, 420));
	const [panelWidth, setPanelWidth] = useState(() => savedWidth("ampi.panel.width", 380, 320, 720));
	const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
	const [zoomToast, setZoomToast] = useState("");
	const previousRegion = useRef<"sidebar" | "transcript" | "composer" | "panel">("transcript");
	const focusAfterRender = useRef<"sidebar" | "transcript" | "composer" | "panel" | null>(null);
	useKeyAction("sidebar.toggle", () => {
		const active = document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region;
		const hidden = sidebarHidden || (squeezedRef.current && !sidebarPeek);
		const action = regionToggle(hidden, active === "sidebar");
		if (action === "show-and-focus") {
			if (squeezedRef.current) setSidebarPeek(true); else setSidebarHidden(false);
			focusAfterRender.current = "sidebar";
		} else if (action === "focus") requestAnimationFrame(() => focusRegion("sidebar"));
		else {
			if (squeezedRef.current) setSidebarPeek(false); else setSidebarHidden(true);
			focusAfterRender.current = previousRegion.current === "sidebar" ? "transcript" : previousRegion.current;
		}
	});
	useKeyAction("panel.toggle", () => {
		if (!route.thread) return;
		if (document.activeElement?.closest('[data-region="panel"]')) {
			toggleArcPanel(panel, setPanel, true);
			focusAfterRender.current = "transcript";
		} else if (!panel) {
			toggleArcPanel(panel, setPanel);
			focusAfterRender.current = "panel";
		} else requestAnimationFrame(() => focusRegion("panel"));
	});
	useKeyAction("focus.composer", () => {
		const region = document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region;
		if (region === "transcript") focusRegion("composer");
		else if (region === "composer") focusRegion("transcript");
	});
	useKeyAction("session.palette", () => setDialog("palette"));
	useKeyAction("command.palette", () => setDialog("commands"));
	useKeyAction("display", () => setDialog("display"));
	useKeyAction("help", () => setDialog("help"));
	useKeyAction("zoom.in", () => changeOverallZoom(0.05));
	useKeyAction("zoom.out", () => changeOverallZoom(-0.05));
	useKeyAction("zoom.reset", () => changeOverallZoom(0));
	useKeyAction("overview", () => { location.hash = href.page("overview"); });
	useKeyAction("new", () => setDialog("new"));
	useKeyAction("shell", () => {
		const r = hashRoute();
		if (r.host && r.thread) setPanel((p) => (p === "shell" ? undefined : "shell"));
		else if (r.host) void openTerminal(r.host).catch(() => {});
	});
	useEffect(() => installKeymapDispatcher(), []);
	const changeOverallZoom = (delta: number) => {
		const settings = JSON.parse(localStorage.getItem("ampi.display") ?? "{}") as { overall?: number };
		const overall = delta === 0 ? 1 : Math.min(1.6, Math.max(0.7, Math.round(((settings.overall ?? 1) + delta) * 100) / 100));
		settings.overall = overall;
		localStorage.setItem("ampi.display", JSON.stringify(settings));
		document.documentElement.style.zoom = String(overall);
		window.dispatchEvent(new Event("ampi:display"));
		setZoomToast(`Display size ${Math.round(overall * 100)}%`);
	};
	useEffect(() => {
		const apply = () => {
			const settings = JSON.parse(localStorage.getItem("ampi.display") ?? "{}") as { overall?: number; sidebar?: number; transcript?: number; composer?: number; panel?: number };
			document.documentElement.style.zoom = String(settings.overall ?? 1);
			for (const region of ["sidebar", "transcript", "composer", "panel"] as const) {
				const root = document.querySelector<HTMLElement>(`[data-region="${region}"]`);
				if (root) root.style.zoom = String(settings[region] ?? 1);
			}
		};
		apply();
		window.addEventListener("ampi:display", apply);
		return () => window.removeEventListener("ampi:display", apply);
	}, [route.host, route.thread, panel]);
	useEffect(() => { if (zoomToast) { const timer = setTimeout(() => setZoomToast(""), 1800); return () => clearTimeout(timer); } }, [zoomToast]);
	useEffect(() => {
		const region = document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region;
		if (region === "sidebar" || region === "transcript" || region === "composer" || region === "panel") previousRegion.current = region;
	}, [route.host, route.thread, panel, sidebarHidden, sidebarPeek, windowWidth]);
	useEffect(() => {
		const pending = focusAfterRender.current;
		if (!pending) return;
		focusAfterRender.current = null;
		requestAnimationFrame(() => {
			if (pending === "sidebar") {
				const target = document.querySelector<HTMLElement>('[data-region="sidebar"] [data-nav-row][aria-current], [data-region="sidebar"] [data-nav-row]') ?? document.querySelector<HTMLElement>('[data-region="sidebar"]');
				target?.focus();
			} else focusRegion(pending);
		});
	}, [sidebarHidden, sidebarPeek, panel]);
	useEffect(() => {
		const pointer = () => { document.documentElement.dataset.input = "pointer"; };
		const keyboard = () => { document.documentElement.dataset.input = "keyboard"; };
		document.addEventListener("pointerdown", pointer, true);
		document.addEventListener("keydown", keyboard, true);
		return () => {
			document.removeEventListener("pointerdown", pointer, true);
			document.removeEventListener("keydown", keyboard, true);
		};
	}, []);
	useEffect(() => {
		const resize = () => setWindowWidth(window.innerWidth);
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	useEffect(() => {
		localStorage.setItem("ampi.sidebar.hidden", sidebarHidden ? "1" : "0");
		localStorage.setItem("ampi.sidebar.width", String(sidebarWidth));
		localStorage.setItem("ampi.panel.width", String(panelWidth));
	}, [sidebarHidden, sidebarWidth, panelWidth]);
	const closeDialog = useCallback(() => setDialog(undefined), []);
	const onData = useCallback((id: string, data: HostThreads) => setFeeds((prev) => ({ ...prev, [id]: data })), []);
	useEffect(() => {
		if (panel) localStorage.setItem("ampi.panel", panel);
		else localStorage.removeItem("ampi.panel");
	}, [panel]);
	const data = hosts.map((host) => ({ ...(feeds[host.id] ?? { threads: [], stale: true }), host }));
	useAttention(data, route);
	const listed = data.some((d) => d.threads.length > 0);
	useEffect(() => {
		if (listed) perfMarkPainted("sessions-listed", true);
	}, [listed]);
	useEffect(() => {
		window.addEventListener("pointerdown", requestNotificationPermission, { once: true });
	}, []);
	const hostConnected = hosts.find((h) => h.id === route.host)?.status === "connected";
	const piHere = isPiHost(hosts.find((h) => h.id === route.host));
	// A link can open a panel (`?p=`); after that the choice is the owner's and is remembered.
	useEffect(() => {
		if (route.panel) setPanel(route.panel);
	}, [route.panel]);
	const models: ModelChoice[] = useModels(route.host, hostConnected) ?? [];
	const [accounts, setAccounts] = useState<string>();
	useEffect(() => {
		const open = () => setDialog("new");
		window.addEventListener("ampi:new", open);
		return () => window.removeEventListener("ampi:new", open);
	}, []);
	useEffect(() => {
		const open = (e: Event) => setAccounts((e as CustomEvent).detail as string);
		window.addEventListener("ampi:accounts", open);
		return () => window.removeEventListener("ampi:accounts", open);
	}, []);
	useEffect(() => {
		const key = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (e.key === "Escape" && overlayRef.current && (e.target as HTMLElement)?.closest?.(".panel-slot") && !e.defaultPrevented) {
				// An overlaid panel closes on Escape and hands focus back to the composer, as a sheet should.
				setPanel(undefined);
				const r = hashRoute();
				if (r.panel && r.host && r.thread) history.replaceState(history.state, "", href.thread(r.host, r.thread, r.entry ? { entry: r.entry } : {}));
				requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
			} else if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown") && !(e.target as HTMLElement)?.closest?.("select, [contenteditable], .xterm") && !((e.target as HTMLInputElement)?.value ?? "")) {
				// Works from an empty composer (it autofocuses); never while a draft or another field has text.
				// Alt+↑/↓: the previous or next Session in the sidebar's order.
				const rows = [...document.querySelectorAll<HTMLElement>(".side-scroll .row[data-thread]")];
				if (!rows.length) return;
				e.preventDefault();
				const at = rows.findIndex((row) => row.classList.contains("active"));
				rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]!.click();
			}
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, []);
	const summary = route.host && route.thread ? feeds[route.host]?.threads.find((t) => t.id === route.thread) : undefined;
	// Pi Sessions get the registered panel views (views/registry.ts); node threads keep the node's panels.
	const showPanel = Boolean(route.thread && panel && (piHere ? piPanels(summary).some((p) => p.name === panel) : true));
	const page = PAGES.find((p) => p.name === (route.page ?? (!route.host ? "timeline" : undefined)));
	// When a panel would squeeze the main below a usable width, the sidebar gives way first (not saved; ☰ peeks it back),
	// and only then does the panel overlay the main.
	const squeezed = showPanel && !sidebarHidden && windowWidth - sidebarWidth - panelWidth < 480;
	const sideHidden = sidebarHidden || (squeezed && !sidebarPeek);
	squeezedRef.current = squeezed;
	const overlayPanel = windowWidth - (sideHidden ? 0 : sidebarWidth) - panelWidth < 480;
	overlayRef.current = overlayPanel && showPanel;
	void hash;
	return (
		<FeedsContext.Provider value={feeds}>
		<div className={`app ${sideHidden ? "sidebar-hidden" : ""} ${showPanel ? "has-panel" : ""} ${overlayPanel ? "panel-overlay" : ""}`} style={{ "--side-w": `${sidebarWidth}px`, "--side-visible": sideHidden ? "0px" : "var(--side-w)", "--panel-w": `${panelWidth}px` } as CSSProperties}>
			{zoomToast && <div className="toast" role="status" aria-live="polite">{zoomToast}</div>}
			{hosts.map((host) => (
				<HostFeed key={host.id} host={host} onData={onData} />
			))}
			<div className="sidebar-slot" data-region="sidebar" tabIndex={-1} inert={sideHidden}>
				<Sidebar data={data} route={route} hubConnected={connected} onNew={() => setDialog("new")} onAddHost={() => setDialog("host")} onToggle={() => (squeezed ? setSidebarPeek(false) : setSidebarHidden(true))} />
				<ResizeEdge side="sidebar" width={sidebarWidth} onChange={setSidebarWidth} />
			</div>
			{sideHidden && <button className="btn ghost sidebar-reveal" aria-label="Show sidebar" title={`Show sidebar (${MOD}B)`} onClick={() => (sidebarHidden ? setSidebarHidden(false) : setSidebarPeek(true))}>☰</button>}
			<div className="main-slot">
			{page ? (
				<page.component route={route} />
			) : route.page && route.page !== "overview" ? (
				<div className="main">
					<div className="empty">No page “{route.page}”.</div>
				</div>
			) : route.host && route.term ? (
				<Suspense fallback={<div className="main"><div className="empty">Loading the terminal…</div></div>}>
					<TerminalView key={`${route.host}|${route.term}`} host={route.host} termId={route.term} />
				</Suspense>
			) : route.host && route.thread ? (
				<ThreadView key={`${route.host}|${route.thread}`} host={route.host} threadId={route.thread} summary={summary} models={models} panel={panel} setPanel={setPanel} entry={route.entry} />
			) : (
				<Overview data={data} onNew={() => setDialog("new")} onAddHost={() => setDialog("host")} onHelp={() => setDialog("help")} />
			)}
			</div>
			{!page && route.host && route.thread && panel && showPanel && <div className="panel-slot" data-region="panel" tabIndex={-1} onKeyDown={handleRegionScrollKey}>
				<ResizeEdge side="panel" width={panelWidth} onChange={setPanelWidth} />
				{(piHere ? (
					<PiPanel name={panel} host={route.host} threadId={route.thread} summary={summary} entry={route.entry} setPanel={setPanel} />
				) : (
					<Panel name={panel} host={route.host} threadId={route.thread} summary={summary} setPanel={setPanel} />
				))}
			</div>}
			{dialog === "new" &&
				// On a Pi Host (or when every Host is one) a new agent is started in Herdr (D15 stage 2).
				(isPiHost(hosts.find((h) => h.id === route.host)) || (hosts.length > 0 && hosts.every(isPiHost)) ? (
					<NewAgentDialog hosts={hosts.filter(isPiHost)} defaultHost={route.host} beside={summary} onClose={closeDialog} />
				) : (
					<NewThreadDialog hosts={hosts} defaultHost={route.host} onClose={closeDialog} />
				))}
			{dialog === "host" && <AddHostDialog onClose={() => setDialog(undefined)} />}
			{dialog === "palette" && <Palette data={data} onClose={() => setDialog(undefined)} />}
			{dialog === "commands" && <CommandPalette onClose={() => setDialog(undefined)} />}
			{dialog === "display" && <DisplayDialog onClose={() => setDialog(undefined)} />}
			{dialog === "help" && <HelpDialog onClose={() => setDialog(undefined)} />}
			{accounts && <AccountsDialog host={accounts} hostLabel={hosts.find((h) => h.id === accounts)?.label ?? accounts} onClose={() => setAccounts(undefined)} />}
		</div>
		</FeedsContext.Provider>
	);
}
