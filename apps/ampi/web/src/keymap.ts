import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { overlayChord, type Overlay } from "./focus.ts";
import { carrier } from "./nav.ts";

export type KeyAction =
	| "sidebar.toggle" | "panel.toggle" | "focus.composer"
	| "session.palette" | "command.palette" | "help" | "find"
	| "overview" | "new" | "shell" | "display" | "zoom.in" | "zoom.out" | "zoom.reset"
	| "history.back" | "history.forward";

export type KeyBinding = {
	id: KeyAction;
	code: string;
	meta?: boolean;
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
	label: string;
	region: "global" | "sidebar" | "transcript" | "composer" | "panel";
	palette?: boolean;
	skipEditable?: boolean;
	/** A plain browser runs this chord itself (Back, Forward); AmPi dispatches it only in AmPi.app. */
	browserOwned?: boolean;
	/** A rule help always shows beside the action. */
	note?: string;
	/** A rule that holds only in AmPi.app; help shows it there. */
	appNote?: string;
	/** Where the action is available; help shows it beside an action that is unavailable here. */
	context?: string;
};

/** Panels, later Find jumps, scroll and focus make no steps (D20). */
const HISTORY_NOTE = "Steps are Sessions, pages, entry links and the first Find jump";

/** Single source for global bindings, help rows, and command-palette actions. */
export const KEYMAP: readonly KeyBinding[] = [
	{ id: "sidebar.toggle", code: "KeyB", meta: true, label: "Toggle sidebar", region: "global", palette: true },
	{ id: "panel.toggle", code: "KeyL", meta: true, label: "Toggle side panel", region: "global", palette: true, context: "in a Session" },
	{ id: "panel.toggle", code: "Backslash", meta: true, label: "Toggle side panel", region: "global", palette: true, context: "in a Session" },
	{ id: "focus.composer", code: "KeyI", meta: true, label: "Focus composer", region: "global", palette: true, context: "in a Session" },
	{ id: "session.palette", code: "KeyK", meta: true, label: "Jump to a Session", region: "global", palette: true },
	{ id: "command.palette", code: "KeyK", meta: true, shift: true, label: "Open command palette", region: "global", palette: true },
	{ id: "find", code: "KeyF", meta: true, label: "Find in this Session", region: "global", context: "in a Pi Session" },
	{ id: "overview", code: "Digit0", meta: true, label: "Overview", region: "global", palette: true },
	{ id: "new", code: "KeyN", meta: true, label: "New Session", region: "global", palette: true },
	{ id: "history.back", code: "BracketLeft", meta: true, label: "Back", region: "global", palette: true, browserOwned: true, note: HISTORY_NOTE, appNote: "does nothing at the first AmPi page" },
	{ id: "history.forward", code: "BracketRight", meta: true, label: "Forward", region: "global", palette: true, browserOwned: true },
	{ id: "shell", code: "KeyJ", meta: true, label: "Toggle shell", region: "global", palette: true, context: "on a Host page, or in a Session with a shell" },
	{ id: "zoom.in", code: "Equal", meta: true, shift: true, label: "Increase display size", region: "global", palette: true },
	{ id: "zoom.out", code: "Minus", meta: true, shift: true, label: "Decrease display size", region: "global", palette: true },
	{ id: "zoom.reset", code: "Digit0", meta: true, shift: true, label: "Reset display size", region: "global", palette: true },
	{ id: "display", code: "", label: "Display settings", region: "global", palette: true },
	{ id: "help", code: "Slash", shift: true, label: "Help", region: "global", skipEditable: true },
	{ id: "focus.composer", code: "KeyI", label: "Focus composer (insert)", region: "transcript" },
	...(["transcript", "panel"] as const).flatMap((region) => [
		{ id: "overview" as const, code: "KeyJ", label: "Scroll down", region },
		{ id: "overview" as const, code: "KeyK", label: "Scroll up", region },
		{ id: "overview" as const, code: "KeyD", label: "Scroll half page down", region },
		{ id: "overview" as const, code: "KeyU", label: "Scroll half page up", region },
		{ id: "overview" as const, code: "KeyG", label: "Scroll to top / bottom", region },
	]),
];

const handlers = new Map<KeyAction, (event: KeyboardEvent) => void>();

export function registerKeyAction(id: KeyAction, handler: (event: KeyboardEvent) => void) {
	handlers.set(id, handler);
	return () => { if (handlers.get(id) === handler) handlers.delete(id); };
}

/** No handler means the action is unavailable here: its keys do nothing and help and the palette omit it. */
export function useKeyAction(id: KeyAction, handler: ((event: KeyboardEvent) => void) | undefined) {
	const current = useRef(handler);
	current.current = handler;
	const available = Boolean(handler);
	useEffect(() => {
		if (!available) return;
		return registerKeyAction(id, (event) => current.current?.(event));
	}, [id, available]);
}

/** A global binding is available while its action has a handler; dispatch, help, and the palette share this rule. */
export function keyAvailable(binding: KeyBinding): boolean {
	return binding.region !== "global" || handlers.has(binding.id);
}

export function dispatchKeyAction(id: KeyAction, event: KeyboardEvent) {
	handlers.get(id)?.(event);
}

/** Open Modals, innermost last. Each Modal registers itself on mount, so no caller keeps a dialog list. */
const overlays: Overlay[] = [];

/** Registers an open overlay; global chords then pass only its own close chord and palette switching. Returns the release. */
export function registerOverlay(overlay: Overlay): () => void {
	overlays.push(overlay);
	return () => {
		const i = overlays.lastIndexOf(overlay);
		if (i >= 0) overlays.splice(i, 1);
	};
}

export function openOverlay(): Overlay | undefined {
	return overlays.at(-1);
}

export function dispatchGlobalKey(event: KeyboardEvent) {
	if (event.defaultPrevented) return;
	const binding = KEYMAP.find((entry) => entry.region === "global" && entry.code !== ""
		&& event.code === entry.code
		&& (entry.meta ? event.metaKey || event.ctrlKey : !event.metaKey)
		&& Boolean(event.ctrlKey && !entry.meta) === Boolean(entry.ctrl)
		&& Boolean(event.shiftKey) === Boolean(entry.shift)
		&& Boolean(event.altKey) === Boolean(entry.alt));
	if (!binding || !keyAvailable(binding) || (binding.skipEditable && isEditableTarget(event.target))) return;
	const overlay = openOverlay();
	const blocked = overlay !== undefined && overlayChord(overlay, binding.id) === "blocked";
	// The browser's own Back runs unless a dialog blocks it (R12; that preventDefault is unproven against Chrome's accelerator).
	if (binding.browserOwned && carrier() === "browser" && !blocked) return;
	event.preventDefault();
	if (blocked) return;
	dispatchKeyAction(binding.id, event);
}

export function installKeymapDispatcher(target: Window = window) {
	target.addEventListener("keydown", dispatchGlobalKey);
	return () => target.removeEventListener("keydown", dispatchGlobalKey);
}

/** Editable controls suppress unmodified region keys; modifier bindings remain active there. */
export function isEditableTarget(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable], .xterm"));
}

/** Focus the region root when no navigable row exists. */
export type RegionToggle = "show-and-focus" | "focus" | "hide-and-return";

/** The focus-first toggle contract. `hidden` must be the derived visibility state. */
export function regionToggle(hidden: boolean, focused: boolean): RegionToggle {
	return hidden ? "show-and-focus" : focused ? "hide-and-return" : "focus";
}

/** The only DOM focus writer for the focus model. "page" is the page's own scroller, so Space and ↓ scroll it (R9). */
export function focusRegion(region: "sidebar" | "transcript" | "composer" | "panel" | "page"): boolean {
	const root = document.querySelector<HTMLElement>(region === "page" ? "[data-page-root]" : `[data-region="${region}"]`);
	if (!root || root.closest("[inert]")) return false;
	const target = region === "composer"
		? root.querySelector<HTMLElement>("textarea, input, [contenteditable]") ?? root
		: region === "sidebar"
			? root.querySelector<HTMLElement>("[data-nav-row][aria-current], [data-nav-row]") ?? root
			: region === "page"
				? pageScroller(root)
				: root;
	target.focus();
	return document.activeElement === target;
}

/** The page's marked content scroller (data-page-scroller), else its first scrolling element made focusable, else the root. */
function pageScroller(root: HTMLElement): HTMLElement {
	const marked = root.querySelector<HTMLElement>("[data-page-scroller]");
	if (marked) {
		marked.dataset.pageFocus = "";
		return marked;
	}
	for (const element of root.querySelectorAll<HTMLElement>("*")) {
		if (element.scrollHeight <= element.clientHeight || !/(auto|scroll)/.test(getComputedStyle(element).overflowY)) continue;
		if (element.tabIndex < 0 && !element.hasAttribute("tabindex")) element.tabIndex = -1;
		element.dataset.pageFocus = "";
		return element;
	}
	return root;
}

/** Shared transcript/panel scroll keys. Region handlers stop propagation before window-level listeners. */
export function handleRegionScrollKey(event: ReactKeyboardEvent<HTMLElement>) {
	if (event.metaKey || event.ctrlKey || event.altKey || (event.shiftKey && event.key !== "G") || isEditableTarget(event.target)) return;
	if (!(event.key === "j" || event.key === "k" || event.key === "d" || event.key === "u" || event.key === "g" || event.key === "G")) return;
	const root = event.currentTarget;
	const candidates = [event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".scroll, .panel-body, [data-scrollable]") : null, ...root.querySelectorAll<HTMLElement>(".scroll, .panel-body, [data-scrollable]")];
	const scroller = candidates.find((node): node is HTMLElement => Boolean(node && node.scrollHeight > node.clientHeight));
	if (!scroller) return;
	event.preventDefault();
	event.stopPropagation();
	const line = Number.parseFloat(getComputedStyle(scroller).lineHeight) || 24;
	const pages = { j: 3 * line, k: -3 * line, d: scroller.clientHeight / 2, u: -scroller.clientHeight / 2 };
	// Jumps are instant: a windowed transcript loads entries near its edge and keeps place, which cancels a smooth scroll.
	if (event.key === "g") scroller.scrollTo({ top: 0 });
	else if (event.key === "G") scroller.scrollTo({ top: scroller.scrollHeight });
	else scroller.scrollBy({ top: pages[event.key as keyof typeof pages], behavior: "smooth" });
}
