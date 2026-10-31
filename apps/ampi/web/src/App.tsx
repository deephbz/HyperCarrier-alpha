import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { ThreadsState, ThreadSummary } from "../../src/shared/protocol.ts";
import { findHost, type HostState, useHosts, useTopic } from "./client.ts";
import { AccountsDialog } from "./components/Accounts.tsx";
import { CommandPalette, DisplayDialog, HelpDialog, HostSetupDialog, NewThreadDialog, Palette } from "./components/Dialogs.tsx";
import { useModels } from "./models.ts";
import { Overview } from "./components/Overview.tsx";
import { NewAgentDialog } from "./components/PiDialogs.tsx";
import { PiPanel, piPanels } from "./views/PiPanel.tsx";
import { PAGES } from "./views/registry.ts";
import { Panel } from "./components/Panel.tsx";
import { type HostThreads, Sidebar, SidebarIcon, isPiHost } from "./components/Sidebar.tsx";
import { SessionUnresolved } from "./components/SessionUnresolved.tsx";
import { type ModelChoice, ThreadView } from "./components/ThreadView.tsx";
// xterm is most of the bundle; it loads the first time a terminal is shown.
const TerminalView = lazy(() => import("./components/TerminalView.tsx").then((m) => ({ default: m.TerminalView })));
import { openTerminal } from "./components/Sidebar.tsx";
import { hostLabelFor } from "./components/host-label.ts";
import { hashRoute, href, MOD, type Route } from "./util.ts";
import { FeedsContext, FocusIntentContext } from "./context.ts";
import { requestNotificationPermission, useAttention } from "./attention.ts";
import { perfMarkPainted } from "./perf.ts";
import { focusRegion, handleRegionScrollKey, installKeymapDispatcher, openOverlay, useKeyAction } from "./keymap.ts";
import { remember, transition, type KeyIntent, type Region, type SessionRegion, type Target, type View } from "./focus.ts";
import { PANEL_DEFAULT_KEY, panelClosed } from "./views/cos/arc-reopen.ts";
import { arriveEntry, goBack, goForward, installNavLinks, navigate, noteFocus, ROUTE_EVENT } from "./nav.ts";

import { applyDisplay, type DisplaySettings, scaleOf } from "./display.ts";
import { bindDrawerSwipe } from "./drawer-swipe.ts";
import { installTouchAxis } from "./touch-axis.ts";

function savedWidth(key: string, fallback: number, min: number, max: number) {
	const value = Number(localStorage.getItem(key) ?? fallback);
	return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

/** Below this many CSS px of main, the sidebar gives way and then the panel overlays the main. */
const MAIN_MIN = 480;
/** The layout viewport in CSS px: the unit of the grid widths. `innerWidth` is in viewport px, which display zoom scales. */
const viewWidth = () => document.documentElement.clientWidth;
/** The side panels overlay the main (a phone). styles.css owns the width: its narrow rule sets --side-overlay. */
const sideOverlay = () => getComputedStyle(document.documentElement).getPropertyValue("--side-overlay").trim() === "1";

type Drag = { app: HTMLElement; pointer: number; x: number; scale: number; start: number; width: number };

/**
 * One pointer gesture owns the edge from press to release, cancel or lost capture. The width is the start width plus
 * the pointer's travel, so the grabbed point stays under the cursor. Pointer travel is in viewport px; display zoom
 * (html `zoom`, a region `zoom`) scales each CSS px of the grid, so the gesture fixes that scale at the press.
 * The drag writes only the grid, not every Session component; release commits the drawn width; Escape restores the start.
 */
function ResizeEdge({ side, width, onChange }: { side: "sidebar" | "panel"; width: number; onChange: (width: number) => void }) {
	const drag = useRef<Drag | undefined>(undefined);
	const edge = useRef<HTMLDivElement>(null);
	const min = side === "sidebar" ? 220 : 320;
	const max = side === "sidebar" ? 420 : 720;
	const clamp = (value: number) => Math.max(min, Math.min(max, value));
	const show = (app: HTMLElement, next: number) => {
		app.style.setProperty(side === "sidebar" ? "--side-w" : "--panel-w", `${next}px`);
		edge.current?.setAttribute("aria-valuenow", String(next));
		const sidebar = app.classList.contains("sidebar-hidden") ? 0 : parseFloat(app.style.getPropertyValue("--side-w"));
		app.classList.toggle("panel-overlay", viewWidth() - sidebar - parseFloat(app.style.getPropertyValue("--panel-w")) < MAIN_MIN);
	};
	const end = (commit: boolean) => {
		const gesture = drag.current;
		if (!gesture) return;
		drag.current = undefined;
		if (edge.current?.hasPointerCapture(gesture.pointer)) edge.current.releasePointerCapture(gesture.pointer);
		if (commit) onChange(gesture.width);
		else show(gesture.app, gesture.start);
	};
	// An edge that unmounts mid-gesture (the panel closed) puts the start width back; the React state never changed.
	useEffect(() => () => {
		const gesture = drag.current;
		drag.current = undefined;
		if (gesture) gesture.app.style.setProperty(side === "sidebar" ? "--side-w" : "--panel-w", `${gesture.start}px`);
	}, [side]);
	return <div
		ref={edge}
		className={`resize-edge ${side}-edge`}
		role="separator"
		aria-label={side === "sidebar" ? "Sidebar width" : "Side panel width"}
		aria-orientation="vertical"
		aria-valuemin={min}
		aria-valuemax={max}
		aria-valuenow={width}
		tabIndex={0}
		onKeyDown={(e) => {
			if (drag.current) {
				if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(false); }
				return;
			}
			const direction = side === "sidebar" ? 1 : -1;
			const step = e.shiftKey ? 32 : 8;
			const next = e.key === "Home" ? min : e.key === "End" ? max : e.key === "ArrowLeft" ? width - step * direction : e.key === "ArrowRight" ? width + step * direction : undefined;
			if (next !== undefined) { e.preventDefault(); onChange(clamp(next)); }
		}}
		onPointerDown={(e) => {
			if (e.button !== 0 || !e.isPrimary || drag.current !== undefined) return;
			e.preventDefault();
			e.currentTarget.focus();
			// The pane's drawn width over its CSS width: viewport px per grid px, fixed for the whole gesture.
			const scale = scaleOf(e.currentTarget.parentElement!, width);
			drag.current = { app: e.currentTarget.closest<HTMLElement>(".app")!, pointer: e.pointerId, x: e.clientX, scale, start: width, width };
			e.currentTarget.setPointerCapture(e.pointerId);
		}}
		onPointerMove={(e) => {
			const gesture = drag.current;
			if (!gesture || e.pointerId !== gesture.pointer) return;
			const travel = (e.clientX - gesture.x) / gesture.scale;
			const next = clamp(Math.round(gesture.start + (side === "sidebar" ? travel : -travel)));
			if (next === gesture.width) return;
			gesture.width = next;
			show(gesture.app, next);
		}}
		onPointerUp={(e) => { if (e.pointerId === drag.current?.pointer) end(true); }}
		onPointerCancel={(e) => { if (e.pointerId === drag.current?.pointer) end(false); }}
		onLostPointerCapture={(e) => { if (e.pointerId === drag.current?.pointer) end(true); }}
	/>;
}

/** Subscribes to one host's thread index and reports it upward (hooks cannot loop over a dynamic host list). */
function HostFeed({ host, onData }: { host: HostState; onData: (id: string, data: HostThreads) => void }) {
	const { value, stale, error } = useTopic(host.link, { kind: "threads" });
	useEffect(() => {
		onData(host.link, { host, threads: Object.values(value?.threads ?? {}) as ThreadSummary[], stale, ...(value?.layout ? { layout: value.layout } : {}), indexing: value?.indexing, listing: value?.listing, updating: value?.updating, error });
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

/**
 * The route with its Host named by link key, so every view and request below names one source. A route is unresolved
 * when no listed Host source matches it: before the hub lists its Hosts, after the hub drops a source, or for an ID
 * that names nothing. App mounts no Session view for an unresolved route: a view that keys browser state or requests by
 * the bare Host ID (a shell, a draft) would act on a source that is not there. Resolution reads hostStates, which lists
 * every link in every status; filtering that list by status would unmount Sessions on a link blip.
 */
function linkRoute(route: Route, hosts: HostState[]): { route: Route; resolved: boolean } {
	const link = route.host === undefined ? undefined : findHost(hosts, route.host, route.thread)?.link;
	return { route: link ? { ...route, host: link } : route, resolved: route.host === undefined || link !== undefined };
}

export function App() {
	const { hosts, connected, listed: hostsListed } = useHosts();
	const hash = useRoute();
	const { route, resolved } = linkRoute(hashRoute(), hosts);
	const [feeds, setFeeds] = useState<Record<string, HostThreads>>({});
	const [dialog, setDialog] = useState<"new" | "host" | "palette" | "commands" | "display" | "help" | undefined>();
	const [panel, setPanel] = useState<string | undefined>(() => localStorage.getItem("ampi.panel") ?? undefined);
	const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem("ampi.sidebar.hidden") === "1");
	const [sidebarPeek, setSidebarPeek] = useState(false);
	// On a phone the sidebar is a drawer: it starts closed on every load and is never saved, so ampi.sidebar.hidden
	// stays the desktop's choice. A width change across the narrow rule writes nothing.
	const [oneSide, setOneSide] = useState(sideOverlay);
	const [drawer, setDrawer] = useState(false);
	const oneSideRef = useRef(false);
	const squeezedRef = useRef(false);
	const overlayRef = useRef(false);
	const [sidebarWidth, setSidebarWidth] = useState(() => savedWidth("ampi.sidebar.width", 280, 220, 420));
	const [panelWidth, setPanelWidth] = useState(() => savedWidth("ampi.panel.width", 380, 320, 720));
	const [windowWidth, setWindowWidth] = useState(viewWidth);
	const [zoomToast, setZoomToast] = useState("");
	// Focus model adapter (focus.ts). `transition` decides; this adapter snapshots focus at dispatch, applies the view
	// change, and walks the target chain once per request after commit. `recentRegions` is a ref: focus changes never re-render.
	const recentRegions = useRef<SessionRegion[]>(["transcript"]);
	const lastFocused = useRef<Element | null>(null);
	const viewRef = useRef<View>({ session: false, sidebarHidden: false, panelShown: false, modal: false, oneSide: false });
	// Whether a panel name renders in the current Session; set each render, read by the stable panel writer.
	const availableRef = useRef<(name: string) => boolean>(() => false);
	const focusSeq = useRef(0);
	const pendingFocus = useRef<{ seq: number; chain: Target[]; ifLost?: true } | undefined>(undefined);
	const [focusRequest, setFocusRequest] = useState<{ seq: number; chain: Target[]; ifLost?: true }>();
	// A Session's regions mount after its data loads, so a request's first target may not exist yet. The adapter keeps it
	// and focuses it when it mounts. The wait belongs to one arrival: the next route arrival, the next key request, any
	// input (pointer, key, wheel) and any focus not placed here end it. No region focuses itself on mount: this adapter is
	// the only writer of a requested focus.
	const awaiting = useRef<Target | undefined>(undefined);
	const placing = useRef(false);
	const place = useRef((target: Target) => {
		placing.current = true;
		try { return focusRegion(target); } finally { placing.current = false; }
	}).current;
	const applyView = useRef({ sidebar: (_show: boolean) => {}, panel: (_open: boolean) => {} });
	// `set` is the View a writer just made and the last render does not hold yet (panel.set).
	const focusIntent = useRef((intent: KeyIntent, entry?: Target, set?: Partial<View>): boolean => {
		const region = (document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region ?? null) as Region | null;
		const next = transition({ ...viewRef.current, modal: openOverlay() !== undefined, ...set }, { region, recent: recentRegions.current, entry }, intent);
		if (next.kind === "unavailable") return false;
		if (next.change.sidebar) applyView.current.sidebar(next.change.sidebar === "show");
		if (next.change.panel) applyView.current.panel(next.change.panel === "open");
		// A view-change request never displaces a pending key request; both resolve from `last`.
		if (next.ifLost && pendingFocus.current && !pendingFocus.current.ifLost) return true;
		recentRegions.current = next.recent;
		if (!next.ifLost) awaiting.current = undefined;
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
	// Each route arrival makes one focus request. Back, Forward or a reload returns to the target the entry held
	// (history.move); a new arrival that opens a Session focuses its composer (session.switch).
	const arrivedThread = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		awaiting.current = undefined;
		const arrival = arriveEntry();
		const intent = routeIntent.current;
		routeIntent.current = undefined;
		const thread = route.thread ? `${route.host}\n${route.thread}` : undefined;
		const opened = thread !== undefined && thread !== arrivedThread.current;
		arrivedThread.current = thread;
		if (arrival.kind === "traverse") focusIntent("history.move", arrival.focus);
		else if (intent) focusIntent(intent);
		else if (opened) focusIntent("session.switch");
	}, [hash]);
	useKeyAction("new", () => setDialog("new"));
	useEffect(() => installKeymapDispatcher(), []);
	const changeOverallZoom = (delta: number) => {
		const settings = JSON.parse(localStorage.getItem("ampi.display") ?? "{}") as DisplaySettings;
		const overall = delta === 0 ? 1 : Math.min(1.6, Math.max(0.7, Math.round(((settings.overall ?? 1) + delta) * 100) / 100));
		settings.overall = overall;
		localStorage.setItem("ampi.display", JSON.stringify(settings));
		applyDisplay(settings);
		window.dispatchEvent(new Event("ampi:display"));
		setZoomToast(`Display size ${Math.round(overall * 100)}%`);
	};
	useEffect(() => {
		const apply = () => applyDisplay();
		apply();
		window.addEventListener("ampi:display", apply);
		return () => window.removeEventListener("ampi:display", apply);
	}, [route.host, route.thread, panel]);
	useEffect(() => { if (zoomToast) { const timer = setTimeout(() => setZoomToast(""), 1800); return () => clearTimeout(timer); } }, [zoomToast]);
	useEffect(() => {
		const record = (event: FocusEvent) => {
			if (!placing.current) awaiting.current = undefined;
			lastFocused.current = event.target as Element;
			const region = (event.target as Element | null)?.closest?.<HTMLElement>("[data-region]")?.dataset.region;
			if (region === "transcript" || region === "composer" || region === "panel") recentRegions.current = remember(recentRegions.current, region);
			const target = region ?? ((event.target as Element | null)?.closest?.("[data-page-root]") ? "page" : undefined);
			if (target) noteFocus(target as Target);
		};
		document.addEventListener("focusin", record);
		// A click on empty space leaves focus on body on purpose: forget the element, so a later removal steals nothing (R11).
		// A removed or inerted element lost focus to a layout change. The browser blurs an inerted element at its next focus
		// fixup, which can come after the observer below has run, so this path restores focus too; the first path forgets it.
		const leave = (event: FocusEvent) => {
			const was = event.target as Element;
			setTimeout(() => {
				if (lastFocused.current !== was || document.activeElement !== document.body) return;
				lastFocused.current = null;
				if (!was.isConnected || was.closest("[inert]")) focusIntent("layout.change");
			});
		};
		document.addEventListener("focusout", leave);
		// Any other writer that removes or inerts the focused element (resize, squeeze, auto-collapse) is a layout change.
		const lost = new MutationObserver(() => {
			if (awaiting.current && place(awaiting.current)) { awaiting.current = undefined; return; }
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
			const [first, ...rest] = focusRequest.chain;
			if (place(first!)) return;
			if (!focusRequest.ifLost) awaiting.current = first;
			for (const target of rest) if (place(target)) return;
		});
		return () => cancelAnimationFrame(frame);
	}, [focusRequest]);
	useEffect(() => {
		const pointer = () => { document.documentElement.dataset.input = "pointer"; awaiting.current = undefined; };
		const keyboard = () => { document.documentElement.dataset.input = "keyboard"; awaiting.current = undefined; };
		const wheel = () => { awaiting.current = undefined; };
		document.addEventListener("pointerdown", pointer, true);
		document.addEventListener("keydown", keyboard, true);
		document.addEventListener("wheel", wheel, { capture: true, passive: true });
		return () => {
			document.removeEventListener("pointerdown", pointer, true);
			document.removeEventListener("keydown", keyboard, true);
			document.removeEventListener("wheel", wheel, true);
		};
	}, []);
	useEffect(() => {
		// Display zoom changes the CSS width of the window without a resize event.
		// A width that leaves the narrow rule ends the drawer's visit: a later phone width (a rotation back) starts closed.
		const resize = () => { const overlay = sideOverlay(); setWindowWidth(viewWidth()); setOneSide(overlay); if (!overlay) setDrawer(false); };
		resize();
		window.addEventListener("resize", resize);
		window.addEventListener("ampi:display", resize);
		return () => {
			window.removeEventListener("resize", resize);
			window.removeEventListener("ampi:display", resize);
		};
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
	const data = hosts.map((host) => ({ ...(feeds[host.link] ?? { threads: [], stale: true }), host }));
	useAttention(data, route);
	const listed = data.some((d) => d.threads.length > 0);
	useEffect(() => {
		if (listed) perfMarkPainted("sessions-listed", true);
	}, [listed]);
	useEffect(() => {
		window.addEventListener("pointerdown", requestNotificationPermission, { once: true });
	}, []);
	// An unresolved route names no source, so nothing below acts on its bare Host ID.
	const routeHost = resolved ? findHost(hosts, route.host) : undefined;
	const hostConnected = routeHost?.status === "connected";
	const piHere = isPiHost(routeHost);
	// A link can open a panel (`?p=`); after that the choice is the owner's and is remembered.
	useEffect(() => {
		if (!route.panel) return;
		setPanel(route.panel);
		// Only a phone has a view rule for a set panel (one side at a time); desktop focus stays as it was.
		if (oneSideRef.current) focusIntent("panel.set", undefined, { panelShown: true });
	}, [route.panel]);
	// A route arrival from any source (a palette pick, a new Session, Back) closes a phone's drawer (focus.ts navigate).
	// By design this includes a route change the app starts (a redirect): the drawer then shows a page the owner left.
	useEffect(() => { focusIntent("navigate"); }, [route.host, route.thread, route.term, route.page]);
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
				// Works from an empty composer (a Session opens in it); never while a draft or another field has text.
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
	const showPanel = Boolean(resolved && route.thread && panel && panelAvailable(panel));
	// Every panel writer (✕, tabs, ⌘J, links, the Arc toggle) reports a view change; focus moves only if it was lost (R11).
	const setPanelTracked = useCallback((next?: string) => { setPanel(next); focusIntent("panel.set", undefined, { panelShown: Boolean(next && availableRef.current(next)) }); }, []);
	availableRef.current = (name) => Boolean(route.thread) && panelAvailable(name);
	const defaultPanel = () => {
		const saved = localStorage.getItem(PANEL_DEFAULT_KEY) || "arc";
		return panelAvailable(saved) ? saved : panelAvailable("arc") ? "arc" : piHere ? piPanels(summary)[0]?.name : "arc";
	};
	applyView.current = {
		// The one sidebar writer: the phone's drawer, the squeezed sidebar's peek, or the saved desktop choice.
		sidebar: (show) => (oneSideRef.current ? setDrawer(show) : squeezedRef.current ? setSidebarPeek(show) : setSidebarHidden(!show)),
		panel: (open) => {
			if (!open && panel) panelClosed(panel);
			setPanel(open ? defaultPanel() : undefined);
			const r = hashRoute();
			if (!open && r.panel && r.host && r.thread) navigate(href.thread(r.host, r.thread, r.entry ? { entry: r.entry } : {}), "replace", { reveal: false });
		},
	};
	// Where no shell panel exists (a Pi Session), ⌘J is unavailable: it does nothing and help names its context.
	useKeyAction("shell", route.host && (!route.thread || panelAvailable("shell")) ? () => {
		const { route: r, resolved } = linkRoute(hashRoute(), hosts);
		if (r.host && r.thread) { if (resolved) setPanelTracked(panel === "shell" ? undefined : "shell"); }
		else if (r.host) void openTerminal(r.host).catch(() => {});
	} : undefined);
	const page = PAGES.find((p) => p.name === (route.page ?? (!route.host ? "timeline" : undefined)));
	// A phone's swipe drives the same commands as ☰, the hide button, ⌘L and the panel's ✕.
	const appRef = useRef<HTMLDivElement>(null);
	// The one touch-axis decision serves the swipe and the reader's scroll inputs (keep-place, ThreadView).
	useEffect(() => installTouchAxis(), []);
	useEffect(() => bindDrawerSwipe(appRef.current!, {
		view: () => ({ ...viewRef.current, modal: openOverlay() !== undefined }),
		commit: (side, open) => { focusIntent(side === "sidebar" ? (open ? "sidebar.show" : "sidebar.hide") : open ? "panel.toggle" : "panel.close"); },
	}), []);
	// While a swipe opens the panel, an empty sheet with the default panel's title follows the finger.
	const sheet = oneSide && !page && route.host && route.thread && !showPanel ? (piHere ? piPanels(summary).find((p) => p.name === defaultPanel())?.label : defaultPanel()) : undefined;
	// When a panel would squeeze the main below a usable width, the sidebar gives way first (not saved; ☰ peeks it back),
	// and only then does the panel overlay the main.
	const squeezed = !oneSide && showPanel && !sidebarHidden && windowWidth - sidebarWidth - panelWidth < MAIN_MIN;
	const sideHidden = oneSide ? !drawer : sidebarHidden || (squeezed && !sidebarPeek);
	squeezedRef.current = squeezed;
	oneSideRef.current = oneSide;
	const overlayPanel = windowWidth - (sideHidden ? 0 : sidebarWidth) - panelWidth < MAIN_MIN;
	overlayRef.current = overlayPanel && showPanel;
	viewRef.current = { session: sessionView, sidebarHidden: sideHidden, panelShown: showPanel, modal: false, oneSide };
	void hash;
	return (
		<FeedsContext.Provider value={feeds}>
		<FocusIntentContext.Provider value={focusIntent}>
		<div ref={appRef} className={`app ${sideHidden ? "sidebar-hidden" : ""} ${showPanel ? "has-panel" : ""} ${overlayPanel ? "panel-overlay" : ""}`} style={{ "--side-w": `${sidebarWidth}px`, "--side-visible": sideHidden ? "0px" : "var(--side-w)", "--panel-w": `${panelWidth}px` } as CSSProperties}>
			{zoomToast && <div className="toast" role="status" aria-live="polite">{zoomToast}</div>}
			{hosts.map((host) => (
				<HostFeed key={host.link} host={host} onData={onData} />
			))}
			{/* A row that navigates closes a phone's drawer, also the open Session's row, which changes no route. */}
			<div className="sidebar-slot" data-region="sidebar" tabIndex={-1} inert={sideHidden} onClickCapture={(event) => { const target = event.target as Element; if (target.closest("[data-nav-row], [data-thread]") && !target.closest("button")) focusIntent("navigate"); }}>
				<Sidebar data={data} route={route} hubConnected={connected} onNew={() => setDialog("new")} onHostSetup={() => setDialog("host")} onToggle={() => { focusIntent("sidebar.hide"); }} />
				<ResizeEdge side="sidebar" width={sidebarWidth} onChange={setSidebarWidth} />
			</div>
			{sideHidden && <button className="btn ghost small sidebar-reveal" aria-label="Show sidebar" title={`Show sidebar (${MOD}B)`} onClick={() => { focusIntent("sidebar.show"); }}><SidebarIcon /></button>}
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
			) : route.host && route.thread && !resolved ? (
				<SessionUnresolved host={route.host} hosts={hosts} connected={connected} listed={hostsListed} />
			) : route.host && route.thread ? (
				<ThreadView key={`${route.host}|${route.thread}`} host={route.host} threadId={route.thread} summary={summary} models={models} panel={panel} setPanel={setPanelTracked} entry={route.entry} />
			) : (
				<Overview data={data} onNew={() => setDialog("new")} onHostSetup={() => setDialog("host")} onHelp={() => setDialog("help")} />
			)}
			</div>
			{sheet && <div className="drawer-sheet" aria-hidden="true" inert><div className="panel-tabs"><span className="drawer-sheet-title">{sheet}</span></div></div>}
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
				(isPiHost(routeHost) || (hosts.length > 0 && hosts.every(isPiHost)) ? (
					<NewAgentDialog hosts={hosts.filter(isPiHost)} defaultHost={route.host} beside={summary} onClose={closeDialog} />
				) : (
					<NewThreadDialog hosts={hosts} defaultHost={route.host} onClose={closeDialog} />
				))}
			{dialog === "host" && <HostSetupDialog onClose={() => setDialog(undefined)} />}
			{dialog === "palette" && <Palette data={data} query={paletteQuery.current} onQuery={(query) => { paletteQuery.current = query; }} onClose={() => setDialog(undefined)} />}
			{dialog === "commands" && <CommandPalette query={paletteQuery.current} onQuery={(query) => { paletteQuery.current = query; }} onClose={() => setDialog(undefined)} />}
			{dialog === "display" && <DisplayDialog onClose={() => setDialog(undefined)} />}
			{dialog === "help" && <HelpDialog onClose={() => setDialog(undefined)} />}
			{accounts && <AccountsDialog host={accounts} hostLabel={hostLabelFor(accounts, hosts)} onClose={() => setAccounts(undefined)} />}
		</div>
		</FocusIntentContext.Provider>
		</FeedsContext.Provider>
	);
}
