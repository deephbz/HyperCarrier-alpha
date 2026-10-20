import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
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
import { FeedsContext, FocusIntentContext } from "./context.ts";
import { requestNotificationPermission, useAttention } from "./attention.ts";
import { perfMarkPainted } from "./perf.ts";
import { focusRegion, handleRegionScrollKey, installKeymapDispatcher, openOverlay, useKeyAction } from "./keymap.ts";
import { remember, transition, type KeyIntent, type Region, type SessionRegion, type Target, type View } from "./focus.ts";
import { PANEL_DEFAULT_KEY, panelClosed } from "./views/cos/arc-reopen.ts";
import { arriveEntry, goBack, goForward, installNavLinks, navigate, noteFocus, ROUTE_EVENT } from "./nav.ts";

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
	const { value, stale, error } = useTopic(host.id, { kind: "threads" });
	useEffect(() => {
		onData(host.id, { host, threads: Object.values(value?.threads ?? {}) as ThreadSummary[], stale, ...(value?.layout ? { layout: value.layout } : {}), indexing: value?.indexing, listing: value?.listing, updating: value?.updating, error });
	}, [host, value, stale, error, onData]);
	return null;
}

function useRoute() {
	return useSyncExternalStore(
		(listener) => {
			window.addEventListener("hashchange", listener);
			window.addEventListener(ROUTE_EVENT, listener);
			return () => { window.removeEventListener("hashchange", listener); window.removeEventListener(ROUTE_EVENT, listener); };
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
	// Focus model adapter (focus.ts). `transition` decides; this adapter snapshots focus at dispatch, applies the view
	// change, and walks the target chain once per request after commit. `recentRegions` is a ref: focus changes never re-render.
	const recentRegions = useRef<SessionRegion[]>(["transcript"]);
	const lastFocused = useRef<Element | null>(null);
	const viewRef = useRef<View>({ session: false, sidebarHidden: false, panelShown: false, modal: false });
	const focusSeq = useRef(0);
	const pendingFocus = useRef<{ seq: number; chain: Target[]; ifLost?: true } | undefined>(undefined);
	const [focusRequest, setFocusRequest] = useState<{ seq: number; chain: Target[]; ifLost?: true }>();
	const applyView = useRef({ sidebar: (_show: boolean) => {}, panel: (_open: boolean) => {} });
	const focusIntent = useRef((intent: KeyIntent, entry?: Target): boolean => {
		const region = (document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region ?? null) as Region | null;
		const next = transition({ ...viewRef.current, modal: openOverlay() !== undefined }, { region, recent: recentRegions.current, entry }, intent);
		if (next.kind === "unavailable") return false;
		// A view-change request never displaces a pending key request; both resolve from `last`.
		if (next.ifLost && pendingFocus.current && !pendingFocus.current.ifLost) return true;
		recentRegions.current = next.recent;
		if (next.change.sidebar) applyView.current.sidebar(next.change.sidebar === "show");
		if (next.change.panel) applyView.current.panel(next.change.panel === "open");
		pendingFocus.current = { seq: ++focusSeq.current, chain: next.chain, ifLost: next.ifLost };
		setFocusRequest(pendingFocus.current);
		return true;
	}).current;
	const sessionView = Boolean(route.host && route.thread && !route.term && !route.page);
	useKeyAction("sidebar.toggle", () => { focusIntent("sidebar.toggle"); });
	useKeyAction("panel.toggle", sessionView ? () => { focusIntent("panel.toggle"); } : undefined);
	useKeyAction("focus.composer", sessionView ? () => { focusIntent("composer.toggle"); } : undefined);
	// A palette's own chord closes it; ⌘K and ⌘⇧K switch palettes and keep the typed query (the dispatcher gates the rest).
	const paletteQuery = useRef("");
	const openPalette = (which: "palette" | "commands") => setDialog((open) => {
		if (open === which) return undefined;
		if (open !== "palette" && open !== "commands") paletteQuery.current = "";
		return which;
	});
	useKeyAction("session.palette", () => openPalette("palette"));
	useKeyAction("command.palette", () => openPalette("commands"));
	useKeyAction("display", () => setDialog("display"));
	useKeyAction("help", () => setDialog((open) => (open === "help" ? undefined : "help")));
	useKeyAction("zoom.in", () => changeOverallZoom(0.05));
	useKeyAction("zoom.out", () => changeOverallZoom(-0.05));
	useKeyAction("zoom.reset", () => changeOverallZoom(0));
	// A focus intent that waits for the route it navigated to; it runs once that route has rendered.
	const routeIntent = useRef<KeyIntent | undefined>(undefined);
	useKeyAction("overview", () => {
		routeIntent.current = "overview";
		if (navigate(href.page("overview"))) return;
		routeIntent.current = undefined;
		focusIntent("overview");
	});
	useKeyAction("history.back", goBack);
	useKeyAction("history.forward", goForward);
	useEffect(() => installNavLinks(), []);
	// Each route arrival: Back, Forward or a reload returns to the target the entry held (history.move).
	useLayoutEffect(() => {
		const arrival = arriveEntry();
		const intent = routeIntent.current;
		routeIntent.current = undefined;
		if (arrival.kind === "traverse") focusIntent("history.move", arrival.focus);
		else if (intent) focusIntent(intent);
	}, [hash]);
	useKeyAction("new", () => setDialog("new"));
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
		const record = (event: FocusEvent) => {
			lastFocused.current = event.target as Element;
			const region = (event.target as Element | null)?.closest?.<HTMLElement>("[data-region]")?.dataset.region;
			if (region === "transcript" || region === "composer" || region === "panel") recentRegions.current = remember(recentRegions.current, region);
			const target = region ?? ((event.target as Element | null)?.closest?.("[data-page-root]") ? "page" : undefined);
			if (target) noteFocus(target as Target);
		};
		document.addEventListener("focusin", record);
		// A click on empty space leaves focus on body on purpose: forget the element, so a later removal steals nothing (R11).
		// A removed or inerted element stays remembered; the observer below handles it first.
		const leave = (event: FocusEvent) => {
			const was = event.target as Element;
			setTimeout(() => {
				if (lastFocused.current === was && document.activeElement === document.body && was.isConnected && !was.closest("[inert]")) lastFocused.current = null;
			});
		};
		document.addEventListener("focusout", leave);
		// Any other writer that removes or inerts the focused element (resize, squeeze, auto-collapse) is a layout change.
		const lost = new MutationObserver(() => {
			const was = lastFocused.current;
			if (document.activeElement !== document.body || !was || (was.isConnected && !was.closest("[inert]"))) return;
			lastFocused.current = null;
			focusIntent("layout.change");
		});
		lost.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["inert"] });
		return () => { document.removeEventListener("focusin", record); document.removeEventListener("focusout", leave); lost.disconnect(); };
	}, []);
	useEffect(() => {
		if (!focusRequest) return;
		const frame = requestAnimationFrame(() => {
			if (pendingFocus.current?.seq === focusRequest.seq) pendingFocus.current = undefined;
			if (focusRequest.ifLost && document.activeElement && document.activeElement !== document.body) return;
			for (const target of focusRequest.chain) if (focusRegion(target)) return;
		});
		return () => cancelAnimationFrame(frame);
	}, [focusRequest]);
	useEffect(() => { if (route.thread) focusIntent("session.switch"); }, [route.host, route.thread]);
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
				// An overlaid panel closes on Escape, as a sheet should; focus returns to `last`.
				focusIntent("panel.close");
			} else if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown") && !(e.target as HTMLElement)?.closest?.("select, [contenteditable], .xterm") && !((e.target as HTMLInputElement)?.value ?? "")) {
				// Works from an empty composer (it autofocuses); never while a draft or another field has text.
				// Alt+↑/↓: the previous or next Session in the sidebar's order.
				const rows = [...document.querySelectorAll<HTMLElement>(".side-scroll .row[data-thread]")];
				if (!rows.length) return;
				e.preventDefault();
				const at = rows.findIndex((row) => row.classList.contains("active"));
				const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]!;
				// Open the row's Session link: a click on a Team leader's row toggles its Workers instead.
				(next.querySelector<HTMLElement>("a.title") ?? next).click();
			}
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, []);
	const summary = route.host && route.thread ? feeds[route.host]?.threads.find((t) => t.id === route.thread) : undefined;
	// Pi Sessions get the registered panel views (views/registry.ts); node threads keep the node's panels.
	const panelAvailable = (name: string) => !piHere || piPanels(summary).some((p) => p.name === name);
	const showPanel = Boolean(route.thread && panel && panelAvailable(panel));
	// Every panel writer (✕, tabs, ⌘J, links, the Arc toggle) reports a view change; focus moves only if it was lost (R11).
	const setPanelTracked = useCallback((next?: string) => { setPanel(next); focusIntent("panel.set"); }, []);
	const defaultPanel = () => {
		const saved = localStorage.getItem(PANEL_DEFAULT_KEY) || "arc";
		return panelAvailable(saved) ? saved : panelAvailable("arc") ? "arc" : piHere ? piPanels(summary)[0]?.name : "arc";
	};
	applyView.current = {
		sidebar: (show) => (squeezedRef.current ? setSidebarPeek(show) : setSidebarHidden(!show)),
		panel: (open) => {
			if (!open && panel) panelClosed(panel);
			setPanel(open ? defaultPanel() : undefined);
			const r = hashRoute();
			if (!open && r.panel && r.host && r.thread) navigate(href.thread(r.host, r.thread, r.entry ? { entry: r.entry } : {}), "replace");
		},
	};
	// Where no shell panel exists (a Pi Session), ⌘J is unavailable: it does nothing and help names its context.
	useKeyAction("shell", route.host && (!route.thread || panelAvailable("shell")) ? () => {
		const r = hashRoute();
		if (r.host && r.thread) setPanelTracked(panel === "shell" ? undefined : "shell");
		else if (r.host) void openTerminal(r.host).catch(() => {});
	} : undefined);
	const page = PAGES.find((p) => p.name === (route.page ?? (!route.host ? "timeline" : undefined)));
	// When a panel would squeeze the main below a usable width, the sidebar gives way first (not saved; ☰ peeks it back),
	// and only then does the panel overlay the main.
	const squeezed = showPanel && !sidebarHidden && windowWidth - sidebarWidth - panelWidth < 480;
	const sideHidden = sidebarHidden || (squeezed && !sidebarPeek);
	squeezedRef.current = squeezed;
	const overlayPanel = windowWidth - (sideHidden ? 0 : sidebarWidth) - panelWidth < 480;
	overlayRef.current = overlayPanel && showPanel;
	viewRef.current = { session: sessionView, sidebarHidden: sideHidden, panelShown: showPanel, modal: false };
	void hash;
	return (
		<FeedsContext.Provider value={feeds}>
		<FocusIntentContext.Provider value={focusIntent}>
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
			<div className="main-slot" data-page-root tabIndex={-1}>
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
				<ThreadView key={`${route.host}|${route.thread}`} host={route.host} threadId={route.thread} summary={summary} models={models} panel={panel} setPanel={setPanelTracked} entry={route.entry} />
			) : (
				<Overview data={data} onNew={() => setDialog("new")} onAddHost={() => setDialog("host")} onHelp={() => setDialog("help")} />
			)}
			</div>
			{!page && route.host && route.thread && panel && showPanel && <div className="panel-slot" data-region="panel" tabIndex={-1} onKeyDown={handleRegionScrollKey}>
				<ResizeEdge side="panel" width={panelWidth} onChange={setPanelWidth} />
				{(piHere ? (
					<PiPanel name={panel} host={route.host} threadId={route.thread} summary={summary} entry={route.entry} setPanel={setPanelTracked} />
				) : (
					<Panel name={panel} host={route.host} threadId={route.thread} summary={summary} setPanel={setPanelTracked} />
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
			{dialog === "palette" && <Palette data={data} query={paletteQuery.current} onQuery={(query) => { paletteQuery.current = query; }} onClose={() => setDialog(undefined)} />}
			{dialog === "commands" && <CommandPalette query={paletteQuery.current} onQuery={(query) => { paletteQuery.current = query; }} onClose={() => setDialog(undefined)} />}
			{dialog === "display" && <DisplayDialog onClose={() => setDialog(undefined)} />}
			{dialog === "help" && <HelpDialog onClose={() => setDialog(undefined)} />}
			{accounts && <AccountsDialog host={accounts} hostLabel={hosts.find((h) => h.id === accounts)?.label ?? accounts} onClose={() => setAccounts(undefined)} />}
		</div>
		</FocusIntentContext.Provider>
		</FeedsContext.Provider>
	);
}
