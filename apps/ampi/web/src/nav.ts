/**
 * Navigation history: the one owner of AmPi's history entries and their state (⌘[ / ⌘], navhistory).
 * Browser history is the only stack. `navigate` is the only route writer: it decides push or replace at write time
 * and stamps the entry. Each entry's `history.state` carries an id, its depth (`nav`), the focus target it last held
 * (`focus`), and the transcript place (ThreadView). Every state write goes through this module.
 */
import type { Target } from "./focus.ts";
import { native } from "./native.ts";
import { parseRoute } from "./util.ts";

/** `nav`: depth from the first AmPi entry; null when unknown (an entry written before this code). */
export type EntryState = { id?: string; nav?: number | null; focus?: Target; place?: unknown };

/** Fired after `navigate` changes the route; pushState and replaceState fire no hashchange. */
export const ROUTE_EVENT = "ampi:route";

/**
 * Who owns ⌘[ / ⌘]. A plain browser runs its own Back and Forward, and AmPi only restores focus and place on arrival.
 * The AmPi.app WKWebView has no Back accelerator, so the keymap calls `goBack` and `goForward` there.
 */
export function carrier(): "app" | "browser" {
	return native() ? "app" : "browser";
}

/** Whether going from one hash to another adds an entry. A step is a place you went to. */
export function entryKind(from: string, to: string, hint?: "replace"): "push" | "replace" {
	if (hint === "replace") return "replace";
	const a = parseRoute(from);
	const b = parseRoute(to);
	// Panels make no entries: within one Session, only an entry jump is a step.
	const sameSession = Boolean(a.thread && b.thread) && a.host === b.host && a.thread === b.thread;
	return sameSession && a.entry === b.entry ? "replace" : "push";
}

/** One Find session: its first match jump is a step, so Back returns to the reading place; later jumps replace it. */
export function findSteps(): () => "replace" | undefined {
	let jumped = false;
	return () => {
		const hint = jumped ? "replace" : undefined;
		jumped = true;
		return hint;
	};
}

const state = (): EntryState => (history.state ?? {}) as EntryState;
let seq = 0;
const newId = () => `${Date.now().toString(36)}.${(seq++).toString(36)}`;

/** The entry the app last arrived on. */
let current: { id?: string; nav: number | null } = { nav: null };

// The notes this page took on each entry, by entry id: the authority for focus and place while the page lives.
// `history.state` is their copy for a reload. WebKit throws SecurityError past about 100 history writes in 10 s, so the
// copy lands at most once per FLUSH_MS, before any navigation, on ⌘[ / ⌘], and on pagehide. `replaceState` reaches
// only the current entry, so the notes of an entry left before its write (a browser Back, a hash edit) wait for a
// return to it and still win there.
const FLUSH_MS = 500;
const NOTES_KEPT = 500;
const notes = new Map<string, EntryState>();
const unwritten = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Writes the current entry's unwritten notes to `history.state`. */
export function flushEntry() {
	if (timer) clearTimeout(timer);
	timer = undefined;
	const id = state().id;
	if (id === undefined || !unwritten.delete(id)) return;
	history.replaceState({ ...state(), ...notes.get(id) }, "");
}

/** The current entry's id; capture it where a note is observed, when the write comes later. */
export function entryId(): string | undefined {
	return state().id;
}

/** The current entry's state with this page's notes on it. The only reader of `history.state`. */
export function entryState(): EntryState {
	const s = state();
	return s.id === undefined ? s : { ...s, ...notes.get(s.id) };
}

/**
 * Records fields on the entry `id`; the history write is deferred (see FLUSH_MS). The id is required: a writer takes
 * `entryId()` where it observes the fact, because its own deferred code (a frame, a timer) can run after a navigation.
 */
export function noteEntry(patch: EntryState, id: string | undefined) {
	if (id === undefined) return;
	const was = notes.get(id);
	notes.delete(id); // Map order is age order: the oldest notes go first
	notes.set(id, { ...was, ...patch });
	if (notes.size > NOTES_KEPT) {
		const oldest = notes.keys().next().value!;
		notes.delete(oldest);
		unwritten.delete(oldest);
	}
	unwritten.add(id);
	if (id === state().id) timer ??= setTimeout(flushEntry, FLUSH_MS);
}

/** Records the focus target on the current entry. */
export function noteFocus(target: Target) {
	if (entryState().focus !== target) noteEntry({ focus: target }, state().id);
}

/** The only route writer. Returns false when `to` is already the route. */
export function navigate(to: string, hint?: "replace"): boolean {
	if (to === location.hash) return false;
	flushEntry();
	const was = entryState();
	if (entryKind(location.hash, to, hint) === "push") {
		current = { id: newId(), nav: current.nav === null ? null : current.nav + 1 };
		history.pushState({ id: current.id, nav: current.nav }, "", to);
	} else {
		// A replaced entry keeps its id, depth and focus; a different transcript entry drops the old place.
		const sameEntry = parseRoute(location.hash).entry === parseRoute(to).entry;
		if (!sameEntry && was.id !== undefined && notes.has(was.id)) notes.set(was.id, { ...notes.get(was.id), place: undefined });
		history.replaceState({ ...was, place: sameEntry ? was.place : undefined }, "", to);
	}
	window.dispatchEvent(new Event(ROUTE_EVENT));
	return true;
}

export type Arrival = { kind: "same" } | { kind: "new" } | { kind: "traverse"; focus?: Target };

/**
 * Call after each route change renders, and once at boot. Back, Forward and a reload return the focus target the entry
 * held. An unstamped entry is new: the boot entry of a fresh tab gets depth 0, an external hash edit gets depth + 1,
 * and an entry with older AmPi state gets an unknown depth. Known error, once per tab after deploy: an older entry
 * written by `location.hash =` also has null state, so reloading it stamps depth 0 and the app's Back stops there.
 */
export function arriveEntry(): Arrival {
	const s = state();
	if (s.id !== undefined && s.id === current.id) return { kind: "same" };
	if (s.id !== undefined) {
		current = { id: s.id, nav: s.nav ?? null };
		if (unwritten.has(s.id)) timer ??= setTimeout(flushEntry, FLUSH_MS);
		return { kind: "traverse", focus: entryState().focus };
	}
	const boot = current.id === undefined;
	const nav = boot ? (history.state === null ? 0 : null) : current.nav === null ? null : current.nav + 1;
	current = { id: newId(), nav };
	history.replaceState({ ...s, id: current.id, nav }, "");
	return { kind: "new" };
}

/** Back never leaves AmPi: it does nothing at a known depth 0. */
export function goBack() {
	flushEntry();
	if (state().nav !== 0) history.back();
}

export function goForward() {
	flushEntry();
	history.forward();
}

/** In-app `<a href="#/…">` links go through `navigate`; installed once on the document, after React's own handlers. */
export function installNavLinks(target: Document = document) {
	const click = (event: MouseEvent) => {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href^="#/"]');
		if (!link || link.target) return;
		event.preventDefault();
		navigate(link.getAttribute("href")!, link.dataset.nav === "replace" ? "replace" : undefined);
	};
	// The waiting focus and place reach the entry before the browser leaves it: ⌘[ / ⌘], a pointer on the toolbar or a
	// mouse Back button, a swipe that hides the page, and an unload. Same-document traversal sends no pagehide.
	const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && (event.code === "BracketLeft" || event.code === "BracketRight")) flushEntry(); };
	target.addEventListener("click", click);
	target.addEventListener("keydown", key, true);
	target.addEventListener("pointerdown", flushEntry, true);
	target.addEventListener("visibilitychange", flushEntry);
	window.addEventListener("pagehide", flushEntry);
	return () => {
		target.removeEventListener("click", click);
		target.removeEventListener("keydown", key, true);
		target.removeEventListener("pointerdown", flushEntry, true);
		target.removeEventListener("visibilitychange", flushEntry);
		window.removeEventListener("pagehide", flushEntry);
	};
}
