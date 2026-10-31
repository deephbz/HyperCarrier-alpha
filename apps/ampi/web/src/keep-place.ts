import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { scaleOf, toCss } from "./display.ts";
import { browserScrollWay, READER_SCROLL, type ReaderScroll } from "./keymap.ts";
import { touchAxis } from "./touch-axis.ts";

// DOM references belong only to the mounted reader; history stores entry IDs and offsets separately.
// `fragment` names one rendered part of an entry (FRAGMENT), so a remounted fragment is found again.
// `offset`: the anchor's top below the scroller's top, in the scroller's CSS px. The scroller can move on screen and its
// display size can change (a zoom step) between capture and restore; the CSS offset from its own top still holds.
type Anchor = { id: string; offset: number; node?: HTMLElement; unique?: boolean; fragment?: string };
export type ReadingPlace = { bottom: boolean; anchors: Anchor[] };
type Options = { anchor?: HTMLElement | null; accept?: (node: HTMLElement) => boolean };

/** The attribute that names one rendered part of an entry; the entry ID attribute keeps naming the entry. */
export const FRAGMENT = "data-fragment";

/** Keep surviving content at its screen height; a bottom-pinned reader follows the bottom. Never moves focus. */
export function capturePlace(el: HTMLElement, selector: string, attribute: string, bottom: boolean, options: Options = {}): ReadingPlace {
	const bounds = el.getBoundingClientRect();
	const scale = scaleOf(el);
	const visible = [...el.querySelectorAll<HTMLElement>(selector)].filter((node) => node.getBoundingClientRect().height > 0);
	const counts = new Map<string | null, number>();
	for (const node of visible) { const id = node.getAttribute(attribute); counts.set(id, (counts.get(id) ?? 0) + 1); }
	const nodes = visible.filter((node) => !options.accept || options.accept(node));
	const first = nodes.findIndex((node) => node.getBoundingClientRect().bottom > bounds.top);
	const ordered = first < 0 ? nodes.slice().reverse() : [...nodes.slice(first), ...nodes.slice(0, first).reverse()];
	if (options.anchor) ordered.unshift(options.anchor);
	return { bottom, anchors: ordered.flatMap((node) => {
		const id = node.getAttribute(attribute);
		return id ? [{ id, offset: (node.getBoundingClientRect().top - bounds.top) / scale, node, unique: counts.get(id) === 1, fragment: node.getAttribute(FRAGMENT) ?? undefined }] : [];
	}) };
}

/**
 * `shift`: how far the reader scrolled down since the capture, in scrollTop's CSS px; the anchor lands that much higher,
 * so the scroll stays. Rects are screen px; the anchor's CSS offset converts at `el`'s display size now.
 */
export function restorePlace(el: HTMLElement, selector: string, attribute: string, place: ReadingPlace, shift = 0) {
	if (place.bottom) { el.scrollTop = el.scrollHeight; return; }
	const nodes = [...el.querySelectorAll<HTMLElement>(selector)];
	for (const anchor of place.anchors) {
		const matches = nodes.filter((node) => node.getAttribute(attribute) === anchor.id && node.getBoundingClientRect().height > 0);
		// One source entry can render as several prose and fold fragments. Preserve the measured fragment; after a
		// remount, only its fragment key names it, and then the entry ID if it is unique in both projections. A
		// fragment's place among its entry's fragments names nothing. Otherwise try the next surviving anchor.
		const named = anchor.fragment === undefined ? [] : matches.filter((node) => node.getAttribute(FRAGMENT) === anchor.fragment);
		const node = anchor.node && matches.includes(anchor.node) ? anchor.node
			: named.length === 1 ? named[0]
			: anchor.unique !== false && matches.length === 1 ? matches[0] : undefined;
		if (!node) continue;
		const target = el.getBoundingClientRect().top + (anchor.offset - shift) * scaleOf(el);
		const off = () => node.getBoundingClientRect().top - target;
		const delta = toCss(off(), el);
		// Ignore subpixel rounding within half a CSS pixel.
		if (Math.abs(delta) > 0.5) el.scrollTop += delta;
		// WebKit keeps scrollTop in whole screen px and rounds a write down, which leaves up to two CSS px at display zoom.
		// Try the whole-px steps on both sides of the rest and keep the closest place: a step rounded up alone can overshoot
		// by a pixel.
		const rest = off();
		if (Math.abs(rest) > 0.5) {
			// Each try writes a value, never one read back: WebKit rounds a written value again.
			const kept = el.scrollTop, need = Math.abs(toCss(rest, el));
			let best: number | undefined, least = Math.abs(rest), last: number | undefined;
			for (const step of new Set([Math.max(1, Math.floor(need)), Math.ceil(need)])) {
				el.scrollTop = last = kept + Math.sign(rest) * step;
				if (Math.abs(off()) < least) { best = last; least = Math.abs(off()); }
			}
			if (best === undefined) el.scrollTop = kept;
			else if (best !== last) el.scrollTop = best;
		}
		return;
	}
}

/**
 * How close to the bottom counts as "at the end": the reader follows arrivals there, and leaves no place to return to.
 * A list pane (Overview, Rarebit) keeps the 2 px edge, so a pager or step near its end keeps its anchor; the transcript
 * passes END_BAND, the last line or so of reading.
 */
export const END_BAND = 60;

/** A hand-off ends within two renders (the window change, then its tail space); a dev build reports one older than this. */
const HAND_OFF_FRAMES = 2;
export const atEnd = (el: HTMLElement, band = 2) => el.scrollHeight - el.scrollTop - el.clientHeight <= band;

/**
 * A reader pinned at scrollTop `top` has scrolled up and away from the bottom; their scroll event may not have arrived
 * yet. useKeepPlace turns scroll anchoring off, so only the reader or a clamp moves scrollTop; it tells them apart with
 * `clamped`. The transcript asks with the 2 px edge, not its end band: a scroll up leaves at once, whatever its step.
 */
export function leftBottom(el: HTMLElement, top: number, band = 2) {
	return el.scrollTop < top - 2 && !atEnd(el, band);
}

/**
 * Whether a drop below scrollTop `top` is a clamp: content shrank to `low` (its least scrollHeight since `top`), and the
 * browser pulled scrollTop down to that content's bottom. Content can grow again before the clamp's scroll event (WebKit:
 * a render the scroller did not see shrank it, and the next one grew it). Any other drop is the reader's own move, with
 * or without input: a wheel, a key, find-in-page, a link, or a focused element.
 */
export function clamped(el: HTMLElement, top: number, low: number) {
	return el.scrollTop < top - 2 && el.scrollTop + el.clientHeight >= low - 2;
}

/**
 * The height that mutations added at or below the visible bottom. One commit can drop content and add its replacement
 * (a live reply that becomes its entry), and a layout between the two clamps scrollTop; scrollHeight less this height is
 * the content that layout saw. An element's extent runs from its previous sibling's bottom margin to its own; the bottom
 * padding of its containers follows it.
 */
function addedBelow(el: HTMLElement, records: MutationRecord[]) {
	// Rects are screen px; scrollHeight, clientHeight and computed lengths are CSS px, which `scale` turns into screen px.
	const scale = scaleOf(el);
	const bottom = el.getBoundingClientRect().top + el.clientHeight * scale;
	const px = (node: Element, property: "marginTop" | "marginBottom" | "paddingBottom" | "borderBottomWidth") => (Number.parseFloat(getComputedStyle(node)[property]) || 0) * scale;
	const end = (node: Element) => node.getBoundingClientRect().bottom + px(node, "marginBottom");
	const added = records.flatMap((record) => [...record.addedNodes]).filter((node): node is HTMLElement => node instanceof HTMLElement && node.isConnected);
	let height = 0;
	for (const node of added) {
		if (added.some((other) => other !== node && other.contains(node))) continue;
		const prev = node.previousElementSibling;
		const start = prev ? end(prev) : node.getBoundingClientRect().top - px(node, "marginTop");
		let padding = 0;
		for (let box: Element | null = node.parentElement; box && el.contains(box); box = box.parentElement) padding += px(box, "paddingBottom") + px(box, "borderBottomWidth");
		if (start >= bottom - padding - 1) height += end(node) - start;
	}
	return height / scale;
}

/** Puts `input` on every reader scroll input `el` receives (useKeepPlace); returns the unbind. */
function listen(el: HTMLElement, input: (el: HTMLElement, up: boolean | undefined, target: EventTarget | null) => void) {
	const wheel = (event: WheelEvent) => { if (event.deltaY && !event.ctrlKey) input(el, event.deltaY < 0, event.target); };
	const key = (event: KeyboardEvent) => { const way = browserScrollWay(event); if (way) input(el, way === "up", event.target); };
	const shared = (event: Event) => input(el, (event as ReaderScroll).detail.up, el);
	// Only a vertical drag is reader input; a sideways drag belongs to a drawer or a wide block (touch-axis.ts).
	const touch = () => { if (touchAxis() === "y") input(el, undefined, null); };
	// A press on the scroller itself lands on its bar or its padding. A press on the padding scrolls nothing, so it only
	// takes a hand-off back; its way is unknown, so it never moves the pin.
	const press = (event: PointerEvent) => { if (event.target === el) input(el, undefined, null); };
	el.addEventListener("wheel", wheel, { passive: true });
	el.addEventListener("keydown", key);
	el.addEventListener(READER_SCROLL, shared);
	el.addEventListener("touchmove", touch, { passive: true });
	el.addEventListener("pointerdown", press);
	return () => {
		el.removeEventListener("wheel", wheel);
		el.removeEventListener("keydown", key);
		el.removeEventListener(READER_SCROLL, shared);
		el.removeEventListener("touchmove", touch);
		el.removeEventListener("pointerdown", press);
	};
}

export function useKeepPlace(
	scroller: RefObject<HTMLElement | null>,
	selector: string,
	attribute: string,
	pinned: RefObject<boolean>,
	band = 2,
	/** Whether the painted bottom is the newest end. A windowed view whose bottom is not keeps the reader away there. */
	tail: () => boolean = () => true,
) {
	const saved = useRef<ReadingPlace | undefined>(undefined);
	/** Whether the view places the reader itself (a step, a toggle): the hook restores nothing until its `record`. */
	const placing = useRef(false);
	/** A place captured before a render that changes rows, with scrollTop then and the capture's options. */
	const pending = useRef<{ place: ReadingPlace; top: number; options?: Options } | undefined>(undefined);
	const size = useRef({ width: 0, height: 0 });
	const top = useRef(0);
	/** The scroller's display scale (scaleOf) at the record. */
	const scale = useRef(1);
	/** The least scrollHeight since the last record: a mutation, scroll, resize or render reads it. */
	const low = useRef(0);
	/** Reads mutations not yet delivered: a render's layout effects run before its MutationObserver callback. */
	const mutations = useRef<MutationObserver | undefined>(undefined);
	/**
	 * The highest recorded scrollTop since the pin began, or since the bottom. useKeepPlace turns scroll anchoring off, so
	 * only the reader or a clamp lowers scrollTop; a drop below this height is the reader's own scroll up, even in steps
	 * inside the end band.
	 */
	const pinTop = useRef<number | undefined>(undefined);
	/** Whether scrollTop sits below the record only by a clamp; the record (pin and place) then still holds. */
	const clamp = useCallback(() => {
		const el = scroller.current;
		if (!el) return false;
		const records = mutations.current?.takeRecords() ?? [];
		low.current = Math.min(low.current, el.scrollHeight - (records.length ? addedBelow(el, records) : 0));
		return clamped(el, top.current, low.current);
	}, [scroller]);
	const remember = useCallback(() => {
		const el = scroller.current;
		if (!el) return;
		saved.current = capturePlace(el, selector, attribute, pinned.current);
		size.current = { width: el.clientWidth, height: el.clientHeight };
		top.current = el.scrollTop;
		scale.current = scaleOf(el);
		pinTop.current = !pinned.current ? undefined : pinTop.current === undefined || el.scrollTop > pinTop.current || atEnd(el) ? el.scrollTop : pinTop.current;
		// Mutations before this record are measured in it.
		mutations.current?.takeRecords();
		low.current = el.scrollHeight;
	}, [scroller, selector, attribute, pinned]);
	// The one reader of "follow the bottom": a pinned reader who moved up since the pin began has left the bottom at once,
	// whatever the step (a trackpad sends a few px, an animated wheel steps), even if their scroll event (a frame after
	// the scroll) has not arrived yet. Every snap and capture asks this, so the answer does not depend on which layout
	// effect or click handler runs first. Only the reader leaves: a clamp does not.
	const following = useCallback(() => {
		const el = scroller.current;
		if (el && pinned.current && leftBottom(el, pinTop.current ?? top.current) && !clamp()) {
			pinned.current = false;
			pinTop.current = undefined;
			saved.current = capturePlace(el, selector, attribute, false);
		}
		return pinned.current;
	}, [scroller, selector, attribute, pinned, clamp]);
	// The one writer of "go to the newest end": the record moves with scrollTop. The browser sends that scroll's event a
	// frame later and coalesces it with a reader's scroll in the same frame; measured from a stale record, the reader's
	// scroll up would look like a move down and keep them pinned.
	const follow = useCallback(() => {
		const el = scroller.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
		remember();
	}, [scroller, remember]);
	// The one record of a place the view wrote itself (Back's restore, a reveal): it is the reader's place at once. Until
	// that write's scroll event arrives, a resize (the prompt rail mounts) or a render restores the record, and the place
	// from before the write would undo it.
	const record = useCallback(() => { placing.current = false; remember(); }, [remember]);
	/** The current hand-off's number. The reader's own scroll input takes the place back and moves it on (`holds`). */
	const handOffs = useRef(0);
	// The view takes the place over: it writes scrollTop once, in a later layout effect, and then calls `record`. Until
	// then no hook restore writes, whatever order the layout effects run in. The view keeps the returned number with its
	// pending write and writes only while it `holds` that number.
	const handOff = useCallback(() => {
		placing.current = true;
		pending.current = undefined;
		const seq = ++handOffs.current;
		// Node tests import this file and have no `import.meta.env`; Vite sets DEV only in a dev build.
		if (!(import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV) return seq;
		// A hand-off that outlives its renders turns the hook off: no restore, no scroll record, no resize follow.
		let frames = 0;
		const check = () => {
			if (!placing.current || handOffs.current !== seq) return;
			if (++frames < HAND_OFF_FRAMES) { requestAnimationFrame(check); return; }
			console.error(`useKeepPlace: a hand-off lasted ${HAND_OFF_FRAMES} frames without record(); the hook restores nothing until the view records`);
		};
		requestAnimationFrame(check);
		return seq;
	}, []);
	/** Whether hand-off `seq` still owns the place: no reader input and no later hand-off came since. */
	const holds = useCallback((seq: number) => handOffs.current === seq, []);
	/** The first surviving anchor on screen now, without a restore. The view that measures it places it (`handOff`). */
	const measure = useCallback((options?: Options) => {
		const el = scroller.current;
		return el ? capturePlace(el, selector, attribute, false, options).anchors[0] : undefined;
	}, [scroller, selector, attribute]);
	// The reader's own scroll input acts at the input, before its scroll lands. It takes back a place the view holds: the
	// reader wins over a pending step or toggle. A scroll up also leaves the end: a render between the input and its
	// scroll still sees scrollTop at the end and would follow, and that write cancels a smooth scroll. WebKit on macOS
	// applies a wheel's scroll asynchronously, and a scroll key (k, ↑) animates over frames. `up` is undefined for a touch
	// drag or a press on the scroller's own bar: their scroll event decides the pin, so an arrival in that frame follows.
	// A writer that moves scrollTop at once (the companion bar) needs no input here: `following` reads the moved scrollTop.
	// An input that a nested scroller takes, or a scroll past an edge the scroller is at, moves nothing here.
	const readerInput = useCallback((el: HTMLElement, up: boolean | undefined, target: EventTarget | null) => {
		if (up !== undefined && (up ? el.scrollTop <= 0 : atEnd(el, 0))) return;
		for (let node = up === undefined || !(target instanceof Element) ? null : target; node && node !== el; node = node.parentElement) {
			if ((up ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1) && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
		}
		if (placing.current) { placing.current = false; handOffs.current++; }
		if (!up || !pinned.current) return;
		pinned.current = false;
		pinTop.current = undefined;
		saved.current = capturePlace(el, selector, attribute, false);
	}, [selector, attribute, pinned]);
	// The hook listens on its scroller itself, so every scroller it keeps gets every input: a vertical wheel (a pinch zoom
	// is ctrl+wheel), a key the browser scrolls, a shared scroll key wherever focus is (READER_SCROLL), a touch drag, a
	// press on the scroller's own bar. A remounted scroller gets the listeners again.
	const bound = useRef<{ el: HTMLElement; input: typeof readerInput; unbind: () => void } | undefined>(undefined);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (bound.current?.el === el && bound.current.input === readerInput) return;
		bound.current?.unbind();
		bound.current = el ? { el, input: readerInput, unbind: listen(el, readerInput) } : undefined;
	});
	useLayoutEffect(() => () => { bound.current?.unbind(); bound.current = undefined; }, []);
	const capture = useCallback((options?: Options) => {
		const el = scroller.current;
		if (!el) return;
		// After a clamp, the reader's place is the record, not the clamped screen.
		const place = !following() && clamp() && saved.current && !options ? saved.current : capturePlace(el, selector, attribute, following(), options);
		pending.current = { place, top: el.scrollTop, options };
		return place.anchors[0];
	}, [scroller, selector, attribute, following, clamp]);
	// Only the reader or a clamp moves scrollTop. A scrollTop moved since the record is the reader's own scroll, and its
	// scroll event comes a frame later: a render or a resize before it reads the move first and takes it as the event
	// would (`took`). A record taken first leaves the event no move to read. A display-size change (html zoom) moves
	// scrollTop too: WebKit keeps the scroll offset in screen px. The resize that comes with it restores the place.
	const moved = useCallback(() => {
		const el = scroller.current;
		return el ? Math.abs(el.scrollTop - top.current) >= 1 && Math.abs(scaleOf(el) - scale.current) < 0.001 && !clamp() : false;
	}, [scroller, clamp]);
	/**
	 * The reader's own scroll keeps its place. A scroll up leaves the end (`following`); only a scroll down into the end
	 * band follows again.
	 */
	const took = useCallback(() => {
		const el = scroller.current;
		if (!el) return;
		if (following()) pinned.current = tail();
		else if (el.scrollTop > top.current && atEnd(el, band) && tail()) pinned.current = true;
		remember();
	}, [scroller, following, pinned, band, tail, remember]);
	const resized = useCallback(() => {
		const el = scroller.current;
		if (!el || (el.clientWidth === size.current.width && el.clientHeight === size.current.height)) return false;
		if (moved()) { took(); return true; }
		if (saved.current) restorePlace(el, selector, attribute, saved.current);
		// One render can resize the scroller and shrink its content (a run ends: the Composer shrinks while the live reply
		// gives way to its entry). The restore then cannot reach the place, and a clamped reader keeps the record.
		if (clamp()) size.current = { width: el.clientWidth, height: el.clientHeight };
		else remember();
		return true;
	}, [scroller, selector, attribute, remember, clamp, moved, took]);
	const onScroll = useCallback(() => {
		const el = scroller.current;
		// While the view places (at most two renders), a reader's scroll event is dropped: the view writes its place, and
		// its record() reads the scroller as it is then.
		if (!el || placing.current) return;
		// The reader scrolled after a capture, before its render: the rows have not changed yet, so capture here again.
		// The render restores where the reader is now, not where they were.
		if (pending.current) {
			const { options } = pending.current;
			pending.current = { place: capturePlace(el, selector, attribute, following(), options), top: el.scrollTop, options };
			return;
		}
		// A layout-induced scroll event can arrive before ResizeObserver. It must not clear the old bottom pin.
		if (resized()) return;
		// A clamp's scroll event is no scroll: the pin and the place stay until the content grows back.
		if (clamp()) return;
		took();
	}, [scroller, selector, attribute, following, resized, clamp, took]);
	// Scroll anchoring stays off from mount to unmount. React runs every layout cleanup of a commit before its effects:
	// a cleanup that turned anchoring on would let the browser move scrollTop when the restore below reads layout.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const old = el.style.overflowAnchor;
		el.style.overflowAnchor = "none";
		return () => { el.style.overflowAnchor = old; };
	}, [scroller]);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el || placing.current) return;
		if (pending.current) {
			// A scroll whose event has not arrived yet is the reader's too. A clamp lands at the bottom and is no scroll.
			const shift = atEnd(el, 0) ? 0 : el.scrollTop - pending.current.top;
			restorePlace(el, selector, attribute, pending.current.place, shift);
			pending.current = undefined;
		} else if (!resized()) {
			// A render that adds or drops rows above a reader away from the bottom (a paint window that slides as entries
			// arrive) keeps the read entry at its screen height; so does a render that shrank the content below the
			// reader and clamped scrollTop. Any other moved scrollTop is the reader's own scroll. In the middle of a smooth
			// scroll, the render takes the scroll so far; each later scroll event takes the rest from that record (`took`).
			if (moved()) took();
			else if (!following() && saved.current) restorePlace(el, selector, attribute, saved.current);
		}
		// Until the content grows back, a clamped reader keeps the record, so a later render restores the place.
		if (!clamp()) remember();
	});
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		// Content can also change in a render this hook does not see (one child only). A following reader follows it; a
		// reader away keeps the place a clamp took.
		const observer = new ResizeObserver(() => {
			if (placing.current || resized() || pending.current) return;
			if (!following()) {
				if (saved.current && clamp()) { restorePlace(el, selector, attribute, saved.current); if (!clamp()) remember(); }
				return;
			}
			if (!tail() || atEnd(el)) return;
			el.scrollTop = el.scrollHeight;
			remember();
		});
		observer.observe(el);
		if (el.firstElementChild) observer.observe(el.firstElementChild);
		// A render can shrink the content and grow it again before any scroll event or observer, in one task or in two:
		// note the least height a layout between them could see.
		const shrink = new MutationObserver((records) => { low.current = Math.min(low.current, el.scrollHeight - addedBelow(el, records)); });
		shrink.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
		mutations.current = shrink;
		return () => {
			observer.disconnect();
			shrink.disconnect();
			mutations.current = undefined;
		};
	}, [scroller, selector, attribute, resized, following, tail, remember, clamp]);
	return { capture, measure, handOff, holds, onScroll, following, follow, record };
}
