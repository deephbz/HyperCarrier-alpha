/**
 * Focus model: the single owner of focus moves between AmPi regions.
 * `transition` is pure and total. The App adapter snapshots View and Focus, applies the
 * returned view change, then walks `chain` until one target takes DOM focus. Each case maps
 * to one row of the focus table (/tmp/hc-lenses-evidence/focusmodel/TABLE.md §3).
 */

export type Region = "sidebar" | "transcript" | "composer" | "panel";
/** The sidebar never becomes a return target. */
export type SessionRegion = Exclude<Region, "sidebar">;
/** "page" is the main container of a page view (tabindex -1). Focus never rests on body. */
export type Target = Region | "page";

export type KeyIntent =
	| "sidebar.toggle" // ⌘B
	| "sidebar.hide" // the sidebar's hide button
	| "navigate" // a sidebar row or a route arrival: on a phone the drawer closes, also on the open Session's row
	| "panel.toggle" // ⌘L, ⌘\
	| "composer.toggle" // ⌘I
	| "insert" // plain i in the transcript
	| "panel.close" // Esc on an overlaid panel
	| "find.close" // find bar Esc or Close
	| "find.go" // a find match opened: read there
	| "session.switch" // a new route arrival opens a Session: Alt+↑/↓, palette Enter, sidebar row, a link
	| "overview" // ⌘0
	| "history.move" // Back or Forward arrived on an entry: return to the target it held
	// View changes without a focus key. They move focus only when it would drop to body (R11, I20 no focus steal).
	| "sidebar.show" // ☰: it removes itself, so on a desktop focus returns as from a layout change
	| "panel.set" // panel ✕ or tab, ⌘J shell, hash panel, Arc toggle; the View already holds the new panel state
	| "layout.change"; // resize, squeeze, auto-collapse, any other removal of the focused element

export type View = {
	/** A Session is open; pages (Overview, Timeline, Arcs, terminal) have only the sidebar. */
	session: boolean;
	/** Derived visibility: hidden, or squeezed without peek. */
	sidebarHidden: boolean;
	/** Panel state is set and the Host renders it. */
	panelShown: boolean;
	/** A Modal owns focus. */
	modal: boolean;
	/** The side panels overlay the main (a phone): one side shows at a time, so opening one closes the other. */
	oneSide: boolean;
};

export type Focus = {
	/** Region that holds DOM focus; null means body, the find bar, or outside any region. */
	region: Region | null;
	/** Session regions that held focus, most recent first (a ref updated on focusin; never React state). */
	recent: readonly SessionRegion[];
	/** The target the history entry held when it was left (history.move only). */
	entry?: Target;
};

export type ViewChange = { sidebar?: "show" | "hide"; panel?: "open" | "close" };

export type Next =
	| { kind: "unavailable" }
	| { kind: "move"; change: ViewChange; chain: Target[]; recent: SessionRegion[]; ifLost?: true };

const unavailable: Next = { kind: "unavailable" };

function after(view: View, change: ViewChange): View {
	return {
		...view,
		sidebarHidden: change.sidebar ? change.sidebar === "hide" : view.sidebarHidden,
		panelShown: change.panel ? change.panel === "open" : view.panelShown,
	};
}

/** Moves a Session region to the front of the recent list. */
export function remember(recent: readonly SessionRegion[], region: SessionRegion): SessionRegion[] {
	return [region, ...recent.filter((r) => r !== region)];
}

/** The total fallback chain: target, then recent regions, transcript, composer, the visible sidebar, the page root. */
function chainFor(view: View, target: Target, recent: readonly SessionRegion[]): Target[] {
	const steps: Target[] = view.session
		? [target, ...recent, "transcript", "composer", ...(view.sidebarHidden ? [] : ["sidebar" as const]), "page"]
		: [target, ...(view.sidebarHidden ? [] : ["sidebar" as const]), "page"];
	// The page root always exists, so it ends every chain.
	if (target === "page") return ["page"];
	return steps.filter((step, i) => steps.indexOf(step) === i && step !== "page" && (step !== "panel" || view.panelShown) && (view.session || step === "sidebar")).concat("page");
}

/**
 * On a phone (View.oneSide) one side shows at a time. The sidebar stays when the move opens or targets it; otherwise the
 * panel, which the move opened or a writer set, stays and the sidebar hides.
 */
function oneSide(view: View, change: ViewChange, target: Target): ViewChange {
	if (!view.oneSide) return change;
	const next = after(view, change);
	if (!next.panelShown || next.sidebarHidden) return change;
	return change.sidebar === "show" || target === "sidebar" ? { ...change, panel: "close" } : { ...change, sidebar: "hide" };
}

function move(view: View, focus: Focus, target: Target, request: ViewChange = {}): Extract<Next, { kind: "move" }> {
	const change = oneSide(view, request, target);
	const next = after(view, change);
	const recent = target === "sidebar" || target === "page" ? [...focus.recent] : remember(focus.recent, target);
	return { kind: "move", change, chain: chainFor(next, target, recent), recent };
}

/**
 * `last`: the most recent shown Session region other than the one closing, else the transcript. On a phone a return
 * skips the composer: focus there raises the keyboard over the transcript the owner came back to read.
 */
function returnTarget(view: View, focus: Focus, closing?: "panel"): SessionRegion {
	return focus.recent.find((r) => r !== closing && (r !== "panel" || view.panelShown) && !(view.oneSide && r === "composer")) ?? "transcript";
}

export function transition(view: View, focus: Focus, intent: KeyIntent): Next {
	// Focus in a hidden or absent region counts as no region.
	const shown = focus.region === "sidebar" ? !view.sidebarHidden : focus.region === "panel" ? view.panelShown : focus.region === null || view.session;
	if (!shown) focus = { ...focus, region: null };
	// An open Modal blocks every focus key (R12); view changes still resolve.
	if (view.modal && intent !== "session.switch" && intent !== "panel.set" && intent !== "layout.change") return unavailable;
	const from = focus.region ?? "none";
	switch (intent) {
		case "sidebar.toggle":
			if (view.sidebarHidden) return move(view, focus, "sidebar", { sidebar: "show" });
			switch (from) {
				case "sidebar":
					return move(view, focus, view.session ? returnTarget(view, focus) : "page", { sidebar: "hide" });
				case "transcript":
				case "composer":
				case "panel":
				case "none":
					return move(view, focus, "sidebar");
				default:
					return absurd(from);
			}
		case "sidebar.hide":
			if (view.sidebarHidden) return unavailable;
			// As ⌘B from the sidebar: focus there returns to `last`; focus elsewhere stays.
			return move(view, focus, from === "sidebar" || from === "none" ? (view.session ? returnTarget(view, focus) : "page") : from, { sidebar: "hide" });
		case "panel.toggle":
			if (!view.session) return unavailable;
			if (!view.panelShown) return move(view, focus, "panel", { panel: "open" });
			switch (from) {
				case "panel":
					return move(view, focus, returnTarget(view, focus, "panel"), { panel: "close" });
				case "sidebar":
				case "transcript":
				case "composer":
				case "none":
					return move(view, focus, "panel");
				default:
					return absurd(from);
			}
		case "composer.toggle": {
			if (!view.session) return unavailable;
			const target = ({ transcript: "composer", composer: "transcript", sidebar: "composer", panel: "composer", none: "composer" } as const satisfies Record<Region | "none", Target>)[from];
			return move(view, focus, target);
		}
		case "insert": {
			const target = ({ transcript: "composer", composer: null, sidebar: null, panel: null, none: null } as const satisfies Record<Region | "none", Target | null>)[from];
			return view.session && target ? move(view, focus, target) : unavailable;
		}
		case "panel.close":
			if (!view.session || !view.panelShown) return unavailable;
			switch (from) {
				case "transcript":
				case "composer":
				case "sidebar":
					return move(view, focus, from, { panel: "close" });
				case "panel":
				case "none":
					return move(view, focus, returnTarget(view, focus, "panel"), { panel: "close" });
				default:
					return absurd(from);
			}
		case "session.switch":
			// A Session opens in its composer. Back, Forward and a reload arrive by history.move instead. A phone opens it in
			// its transcript: the composer would raise the keyboard over it. The new-agent dialog takes the first prompt.
			return move(view, focus, view.oneSide ? "transcript" : "composer");
		case "overview":
			// ⌘0 opens the Overview and focuses its content, so Space and ↓ scroll it (D20, owner ruling 2026-10-20).
			return move({ ...view, session: false }, focus, "page");
		case "history.move": {
			// The entry's own target if it is shown in this view; else the Session's return target, or the page.
			const saved = focus.entry;
			if (saved === "sidebar" && !view.sidebarHidden) return move(view, focus, "sidebar");
			if (!view.session) return move(view, focus, "page");
			const target = saved === "transcript" || saved === "composer" || (saved === "panel" && view.panelShown) ? saved : returnTarget(view, focus);
			return move(view, focus, target);
		}
		case "find.close":
			return view.session ? move(view, focus, returnTarget(view, focus)) : unavailable;
		case "find.go":
			return view.session ? move(view, focus, "transcript") : unavailable;
		case "navigate":
			return view.oneSide && !view.sidebarHidden ? transition(view, focus, "sidebar.hide") : unavailable;
		case "sidebar.show":
			// A phone's drawer covers the main, so focus goes into it, as from a swipe.
			if (view.oneSide) return move(view, focus, "sidebar", view.sidebarHidden ? { sidebar: "show" } : {});
			return { ...move(view, focus, view.session ? returnTarget(view, focus) : "sidebar", view.sidebarHidden ? { sidebar: "show" } : {}), ifLost: true };
		case "panel.set":
		case "layout.change":
			return { ...move(view, focus, view.session ? returnTarget(view, focus) : view.sidebarHidden ? "page" : "sidebar"), ifLost: true };
		default:
			return absurd(intent);
	}
}

/** Compile-time totality: a new Region or KeyIntent fails here until every case decides it. */
function absurd(value: never): never {
	throw new Error(`focus transition: unhandled ${String(value)}`);
}

/** An open Modal. "dialog" is any Modal without its own opening chord (Display, New thread, Close agent, Accounts…). */
export type Overlay = "palette" | "commands" | "help" | "dialog";

/**
 * Which global chords act while an overlay is open: its own opening chord closes it,
 * and ⌘K / ⌘⇧K switch between the two palettes. Every other chord does nothing.
 */
export function overlayChord(overlay: Overlay, action: string): "close" | "switch" | "blocked" {
	const opener: Partial<Record<Overlay, string>> = { palette: "session.palette", commands: "command.palette", help: "help" };
	if (opener[overlay] === action) return "close";
	if ((overlay === "palette" || overlay === "commands") && (action === "session.palette" || action === "command.palette")) return "switch";
	return "blocked";
}
