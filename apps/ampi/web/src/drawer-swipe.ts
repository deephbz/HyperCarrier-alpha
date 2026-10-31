import { onAxisLock, touchStart } from "./touch-axis.ts";

/**
 * A sideways finger drag opens and closes a phone's side drawers (docs/ux/swipe-drawers.md). The gesture owns only the
 * drag's transient look: classes and --drawer-p (the open fraction) on `.app`. On release it settles and then commits
 * through the same commands as ☰ and ⌘L (`commit`); a cancel commits nothing. It needs installTouchAxis(). During the drag it writes no storage,
 * hash or focus. The commit moves focus into the drawer, which blurs a field: the iOS keyboard closes after the settle.
 */
export type DrawerSide = "sidebar" | "panel";

export type DrawerView = { oneSide: boolean; session: boolean; sidebarHidden: boolean; panelShown: boolean; modal: boolean };

/** A flick faster than this, in px/ms toward a side, settles there whatever the position. */
const FLICK = 0.4;
/** The flick speed reads the last part of the drag. */
const FLICK_WINDOW_MS = 100;
/** A finger that rests this long before it moves makes a long press, which native selection keeps. */
const LONG_PRESS_MS = 400;
const SETTLE_MS = 200;
const FADE_MS = 120;

/** A drag that starts here keeps its own meaning: fields, the prompt rail, resize edges, terminals, dialogs. */
const KEEPS_DRAG = "input, textarea, select, [contenteditable]:not([contenteditable='false']), .prompt-rail, .companion-scrollbar, .resize-edge, .xterm, [role='dialog']";

/** The start keeps its own drag: a field, a rail, an element that scrolls sideways (even at its end), a selection. */
function keepsDrag(target: Element, app: HTMLElement): boolean {
	if (target.closest(KEEPS_DRAG)) return true;
	const selection = getSelection();
	if (selection && !selection.isCollapsed) return true;
	for (let el: Element | null = target; el && el !== app; el = el.parentElement) {
		const style = getComputedStyle(el);
		if (style.touchAction === "none") return true;
		if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(style.overflowX)) return true;
	}
	return false;
}

type Swipe = { side: DrawerSide; opening: boolean; width: number; samples: { t: number; x: number }[]; p: number };

export function bindDrawerSwipe(app: HTMLElement, hooks: { view: () => DrawerView; commit: (side: DrawerSide, open: boolean) => void }): () => void {
	let candidate: { at: number } | undefined;
	let swipe: Swipe | undefined;
	let settling: ReturnType<typeof setTimeout> | undefined;

	const look = (next?: { side: DrawerSide; opening: boolean; p: number; settleMs?: number }) => {
		app.classList.toggle("drawer-drag", Boolean(next));
		app.classList.toggle("drawer-settle", next?.settleMs !== undefined);
		if (next) {
			app.dataset.drawer = next.side;
			app.dataset.drawerOpening = String(next.opening);
			app.style.setProperty("--drawer-p", String(next.p));
			app.style.setProperty("--drawer-ms", `${next.settleMs ?? 0}ms`);
		} else {
			delete app.dataset.drawer;
			delete app.dataset.drawerOpening;
			app.style.removeProperty("--drawer-p");
			app.style.removeProperty("--drawer-ms");
		}
	};
	// The one end of every drag: release (settle, then commit), or cancel (touchcancel, a second finger, a hidden page).
	const end = (release: boolean) => {
		const done = swipe;
		swipe = undefined;
		candidate = undefined;
		unblock();
		if (!done) return;
		const speed = flickSpeed(done);
		const open = release && (Math.abs(speed) > FLICK ? speed > 0 : done.p > 0.5);
		const changed = release && open !== !done.opening;
		const target = open ? 1 : 0;
		const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
		const settleMs = reduced ? 0 : Math.round(SETTLE_MS * Math.abs(target - done.p));
		look({ side: done.side, opening: done.opening, p: target, settleMs });
		settling = setTimeout(() => {
			settling = undefined;
			// panel.toggle is relative: a view that reached the result during the settle (a ?p= link) takes no command.
			const view = hooks.view();
			if (changed && (done.side === "sidebar" ? view.sidebarHidden : !view.panelShown) === open) {
				// A panel's content fades in once its sheet lands.
				if (done.side === "panel" && open && !reduced) {
					app.classList.add("drawer-arrived");
					setTimeout(() => app.classList.remove("drawer-arrived"), FADE_MS + 80);
				}
				hooks.commit(done.side, open);
			}
			// The committed view renders before the drag's look goes, so the drawer never jumps back for a frame.
			requestAnimationFrame(() => requestAnimationFrame(() => look()));
		}, settleMs);
	};
	/** The finger's speed toward the open side, px/ms, over the drag's last FLICK_WINDOW_MS. */
	const flickSpeed = (done: Swipe) => {
		const last = done.samples.at(-1);
		const first = done.samples.find((sample) => last && last.t - sample.t <= FLICK_WINDOW_MS);
		if (!last || !first || last.t === first.t) return 0;
		const toward = done.side === "sidebar" ? 1 : -1;
		return (toward * (last.x - first.x)) / (last.t - first.t);
	};

	const start = (event: TouchEvent) => {
		if (event.touches.length > 1) return end(false);
		const view = hooks.view();
		const target = event.target instanceof Element ? event.target : null;
		candidate = view.oneSide && !view.modal && settling === undefined && target && !keepsDrag(target, app) ? { at: event.timeStamp } : undefined;
		if (candidate) block();
		else unblock();
	};
	const lock = onAxisLock((event, axis) => {
		const begun = candidate;
		candidate = undefined;
		const from = touchStart();
		const touch = event.touches[0];
		if (!begun || axis !== "x" || !from || !touch || event.timeStamp - begun.at > LONG_PRESS_MS) return unblock();
		const view = hooks.view();
		const right = touch.clientX > from.x;
		const side: DrawerSide | undefined = !view.sidebarHidden ? (right ? undefined : "sidebar") : view.panelShown ? (right ? "panel" : undefined) : right ? "sidebar" : view.session ? "panel" : undefined;
		if (!side) return unblock();
		const opening = side === "sidebar" ? view.sidebarHidden : !view.panelShown;
		// The layout viewport: a closing iOS keyboard resizes only the visual one.
		const room = document.documentElement.clientWidth;
		const width = Math.min(room, Number.parseFloat(getComputedStyle(app).getPropertyValue(side === "sidebar" ? "--side-w" : "--panel-w")) || room);
		// The blocking touchmove listener moves the drawer for this event too (window bubble runs after window capture).
		swipe = { side, opening, width, samples: [], p: opening ? 0 : 1 };
	});
	const move = (event: TouchEvent) => {
		const from = touchStart();
		const touch = event.touches[0];
		if (!swipe || !from || !touch) return;
		// The drag is the drawer's: the page neither scrolls nor bounces under it.
		if (event.cancelable) event.preventDefault();
		const toward = swipe.side === "sidebar" ? 1 : -1;
		const travel = (toward * (touch.clientX - from.x)) / swipe.width;
		swipe.p = Math.max(0, Math.min(1, swipe.opening ? travel : 1 + travel));
		swipe.samples.push({ t: event.timeStamp, x: touch.clientX });
		look({ side: swipe.side, opening: swipe.opening, p: swipe.p });
	};
	// Not passive: a locked drag must stop the page's pan from the move that locks it. A blocking listener makes each
	// touch scroll wait for the main thread, so it is bound only from the start of a drag that can become a swipe.
	const block = () => window.addEventListener("touchmove", move, { passive: false });
	const unblock = () => window.removeEventListener("touchmove", move);
	const release = (event: TouchEvent) => { if (event.touches.length === 0) end(true); };
	const cancel = () => end(false);
	const hidden = () => { if (document.visibilityState === "hidden") end(false); };
	app.addEventListener("touchstart", start, { passive: true });
	window.addEventListener("touchend", release, { passive: true });
	window.addEventListener("touchcancel", cancel, { passive: true });
	document.addEventListener("visibilitychange", hidden);
	return () => {
		lock();
		if (settling !== undefined) clearTimeout(settling);
		look();
		app.removeEventListener("touchstart", start);
		unblock();
		window.removeEventListener("touchend", release);
		window.removeEventListener("touchcancel", cancel);
		document.removeEventListener("visibilitychange", hidden);
	};
}
