import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { scaleOf, toCss } from "./display.ts";

// DOM references belong only to the mounted reader; history stores entry IDs and offsets separately.
// `fragment` names one rendered part of an entry (FRAGMENT), so a remounted fragment is found again.
type Anchor = { id: string; top: number; offset: number; node?: HTMLElement; unique?: boolean; fragment?: string };
export type ReadingPlace = { bottom: boolean; anchors: Anchor[] };
type Options = { anchor?: HTMLElement | null; accept?: (node: HTMLElement) => boolean };

/** The attribute that names one rendered part of an entry; the entry ID attribute keeps naming the entry. */
export const FRAGMENT = "data-fragment";

/** Keep surviving content at its screen height; a bottom-pinned reader follows the bottom. Never moves focus. */
export function capturePlace(el: HTMLElement, selector: string, attribute: string, bottom: boolean, options: Options = {}): ReadingPlace {
	const bounds = el.getBoundingClientRect();
	const visible = [...el.querySelectorAll<HTMLElement>(selector)].filter((node) => node.getBoundingClientRect().height > 0);
	const counts = new Map<string | null, number>();
	for (const node of visible) { const id = node.getAttribute(attribute); counts.set(id, (counts.get(id) ?? 0) + 1); }
	const nodes = visible.filter((node) => !options.accept || options.accept(node));
	const first = nodes.findIndex((node) => node.getBoundingClientRect().bottom > bounds.top);
	const ordered = first < 0 ? nodes.slice().reverse() : [...nodes.slice(first), ...nodes.slice(0, first).reverse()];
	if (options.anchor) ordered.unshift(options.anchor);
	return { bottom, anchors: ordered.flatMap((node) => {
		const id = node.getAttribute(attribute);
		const top = node.getBoundingClientRect().top;
		return id ? [{ id, top, offset: top - bounds.top, node, unique: counts.get(id) === 1, fragment: node.getAttribute(FRAGMENT) ?? undefined }] : [];
	}) };
}

/**
 * `shift`: how far the reader scrolled down since the capture, in scrollTop's CSS px; the anchor lands that much higher,
 * so the scroll stays. Anchor tops are screen px; the correction converts them at `el` (display zoom).
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
		const target = anchor.top - shift * scaleOf(el);
		const off = () => node.getBoundingClientRect().top - target;
		const delta = toCss(off(), el);
		// Ignore subpixel rounding within half a CSS pixel.
		if (Math.abs(delta) > 0.5) el.scrollTop += delta;
		// WebKit keeps scrollTop in whole screen px and rounds a write down, which leaves up to two CSS px at display zoom;
		// one more write, rounded away from zero, keeps the closer place.
		const rest = off();
		if (Math.abs(rest) > 0.5) {
			const kept = el.scrollTop;
			el.scrollTop = kept + Math.sign(rest) * Math.ceil(Math.abs(toCss(rest, el)));
			if (Math.abs(off()) >= Math.abs(rest)) el.scrollTop = kept;
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
	/** A place captured before a render that changes rows, with scrollTop then and the capture's options. */
	const pending = useRef<{ place: ReadingPlace; top: number; options?: Options } | undefined>(undefined);
	const size = useRef({ width: 0, height: 0 });
	const top = useRef(0);
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
	// The reader's wheel up leaves the end at its input, before its scroll lands. WebKit on macOS applies a wheel's scroll
	// asynchronously: a render between the wheel and its scroll still sees scrollTop at the end and would follow. A wheel
	// that a nested scroller takes, a pinch zoom, or a scroller already at its top moves nothing here.
	const onWheel = useCallback((event: { deltaY: number; ctrlKey: boolean; target: EventTarget | null }) => {
		const el = scroller.current;
		if (!el || !pinned.current || event.deltaY >= 0 || event.ctrlKey || el.scrollTop <= 0) return;
		for (let node = event.target instanceof Element ? event.target : null; node && node !== el; node = node.parentElement) {
			if (node.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
		}
		pinned.current = false;
		pinTop.current = undefined;
		saved.current = capturePlace(el, selector, attribute, false);
	}, [scroller, selector, attribute, pinned]);
	const capture = useCallback((options?: Options) => {
		const el = scroller.current;
		if (!el) return;
		// After a clamp, the reader's place is the record, not the clamped screen.
		const place = !following() && clamp() && saved.current && !options ? saved.current : capturePlace(el, selector, attribute, following(), options);
		pending.current = { place, top: el.scrollTop, options };
		return place.anchors[0];
	}, [scroller, selector, attribute, following, clamp]);
	const resized = useCallback(() => {
		const el = scroller.current;
		if (!el || (el.clientWidth === size.current.width && el.clientHeight === size.current.height)) return false;
		if (saved.current) restorePlace(el, selector, attribute, saved.current);
		remember();
		return true;
	}, [scroller, selector, attribute, remember]);
	const onScroll = useCallback(() => {
		const el = scroller.current;
		if (!el) return;
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
		// The reader's scroll up leaves the end (`following`); only their scroll down into the end band follows again.
		if (following()) pinned.current = tail();
		else if (el.scrollTop > top.current && atEnd(el, band) && tail()) pinned.current = true;
		remember();
	}, [scroller, selector, attribute, following, pinned, band, tail, resized, remember, clamp]);
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
		if (!el) return;
		if (pending.current) {
			// A scroll whose event has not arrived yet is the reader's too. A clamp lands at the bottom and is no scroll.
			const shift = atEnd(el, 0) ? 0 : el.scrollTop - pending.current.top;
			restorePlace(el, selector, attribute, pending.current.place, shift);
			pending.current = undefined;
		} else {
			const follow = following();
			// A render that adds or drops rows above a reader away from the bottom (a paint window that slides as entries
			// arrive) keeps the read entry at its screen height; so does a render that shrank the content below the
			// reader and clamped scrollTop. Any other moved scrollTop is the reader's own scroll.
			if (!resized() && !follow && saved.current && (Math.abs(el.scrollTop - top.current) < 1 || clamp())) restorePlace(el, selector, attribute, saved.current);
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
			if (resized() || pending.current) return;
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
	return { capture, onScroll, onWheel, following, follow };
}
