import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

export type KeyAction =
	| "sidebar.toggle" | "panel.toggle" | "focus.composer" | "focus.transcript"
	| "session.palette" | "command.palette" | "help" | "find"
	| "overview" | "new" | "shell" | "display" | "zoom.in" | "zoom.out" | "zoom.reset";

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
};

/** Single source for global bindings, help rows, and command-palette actions. */
export const KEYMAP: readonly KeyBinding[] = [
	{ id: "sidebar.toggle", code: "KeyB", meta: true, label: "Toggle sidebar", region: "global", palette: true },
	{ id: "panel.toggle", code: "KeyL", meta: true, label: "Toggle Arc panel", region: "global", palette: true },
	{ id: "panel.toggle", code: "Backslash", meta: true, label: "Toggle Arc panel", region: "global", palette: true },
	{ id: "focus.composer", code: "KeyI", meta: true, label: "Focus composer", region: "global", palette: true },
	{ id: "session.palette", code: "KeyK", meta: true, label: "Jump to a Session", region: "global", palette: true },
	{ id: "command.palette", code: "KeyK", meta: true, shift: true, label: "Open command palette", region: "global", palette: true },
	{ id: "find", code: "KeyF", meta: true, label: "Find in this Session", region: "global" },
	{ id: "overview", code: "Digit0", meta: true, label: "Overview", region: "global", palette: true },
	{ id: "new", code: "KeyN", meta: true, label: "New Session", region: "global", palette: true },
	{ id: "shell", code: "KeyJ", meta: true, label: "Toggle shell", region: "global", palette: true },
	{ id: "zoom.in", code: "Equal", meta: true, shift: true, label: "Increase display size", region: "global", palette: true },
	{ id: "zoom.out", code: "Minus", meta: true, shift: true, label: "Decrease display size", region: "global", palette: true },
	{ id: "zoom.reset", code: "Digit0", meta: true, shift: true, label: "Reset display size", region: "global", palette: true },
	{ id: "display", code: "", label: "Display settings", region: "global", palette: true },
	{ id: "help", code: "Slash", shift: true, label: "Help", region: "global", skipEditable: true },
	{ id: "focus.composer", code: "KeyI", label: "Focus composer (insert)", region: "transcript" },
	{ id: "focus.transcript", code: "KeyI", label: "Focus transcript", region: "composer" },
	...(["transcript", "panel"] as const).flatMap((region) => [
		{ id: "overview" as const, code: "KeyJ", label: "Scroll down", region },
		{ id: "overview" as const, code: "KeyK", label: "Scroll up", region },
		{ id: "overview" as const, code: "KeyD", label: "Scroll half page down", region },
		{ id: "overview" as const, code: "KeyU", label: "Scroll half page up", region },
		{ id: "overview" as const, code: "KeyG", label: "Scroll to top / bottom", region },
	]),
];

const handlers = new Map<KeyAction, (event: KeyboardEvent) => void>();

export function useKeyAction(id: KeyAction, handler: (event: KeyboardEvent) => void) {
	const current = useRef(handler);
	current.current = handler;
	useEffect(() => {
		const registered = (event: KeyboardEvent) => current.current(event);
		handlers.set(id, registered);
		return () => { if (handlers.get(id) === registered) handlers.delete(id); };
	}, [id]);
}

export function dispatchKeyAction(id: KeyAction, event: KeyboardEvent) {
	handlers.get(id)?.(event);
}

export function dispatchGlobalKey(event: KeyboardEvent) {
	if (event.defaultPrevented) return;
	const binding = KEYMAP.find((entry) => entry.region === "global" && entry.code !== ""
		&& event.code === entry.code
		&& (entry.meta ? event.metaKey || event.ctrlKey : !event.metaKey)
		&& Boolean(event.ctrlKey && !entry.meta) === Boolean(entry.ctrl)
		&& Boolean(event.shiftKey) === Boolean(entry.shift)
		&& Boolean(event.altKey) === Boolean(entry.alt));
	if (!binding || (binding.skipEditable && isEditableTarget(event.target))) return;
	event.preventDefault();
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

export function focusRegion(region: "sidebar" | "transcript" | "composer" | "panel"): boolean {
	const root = document.querySelector<HTMLElement>(`[data-region="${region}"]`);
	if (!root || root.closest("[inert]")) return false;
	const target = region === "composer"
		? root.querySelector<HTMLElement>("textarea, input, [contenteditable]") ?? root
		: region === "sidebar"
			? root.querySelector<HTMLElement>("[data-nav-row][aria-current], [data-nav-row]") ?? root
			: root;
	target.focus();
	return document.activeElement === target;
}

/** Shared transcript/panel scroll keys. Region handlers stop propagation before window-level listeners. */
export function handleRegionScrollKey(event: ReactKeyboardEvent<HTMLElement>) {
	if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isEditableTarget(event.target)) return;
	if (!(event.key === "j" || event.key === "k" || event.key === "d" || event.key === "u" || event.key === "g" || event.key === "G")) return;
	const root = event.currentTarget;
	const candidates = [event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".scroll, .panel-body, [data-scrollable]") : null, ...root.querySelectorAll<HTMLElement>(".scroll, .panel-body, [data-scrollable]")];
	const scroller = candidates.find((node): node is HTMLElement => Boolean(node && node.scrollHeight > node.clientHeight));
	if (!scroller) return;
	event.preventDefault();
	event.stopPropagation();
	const line = Number.parseFloat(getComputedStyle(scroller).lineHeight) || 24;
	const pages = { j: 3 * line, k: -3 * line, d: scroller.clientHeight / 2, u: -scroller.clientHeight / 2 };
	if (event.key === "g") scroller.scrollTo({ top: 0, behavior: "smooth" });
	else if (event.key === "G") scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
	else scroller.scrollBy({ top: pages[event.key as keyof typeof pages], behavior: "smooth" });
}
