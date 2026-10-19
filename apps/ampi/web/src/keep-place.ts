import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

type Anchor = { id: string; top: number; offset: number };
export type ReadingPlace = { bottom: boolean; anchors: Anchor[] };
type Options = { anchor?: HTMLElement | null; accept?: (node: HTMLElement) => boolean };

/** Keep surviving content at its screen height; a bottom-pinned reader follows the bottom. Never moves focus. */
export function capturePlace(el: HTMLElement, selector: string, attribute: string, bottom: boolean, options: Options = {}): ReadingPlace {
	const bounds = el.getBoundingClientRect();
	const nodes = [...el.querySelectorAll<HTMLElement>(selector)].filter((node) => (!options.accept || options.accept(node)) && node.getBoundingClientRect().height > 0);
	const first = nodes.findIndex((node) => node.getBoundingClientRect().bottom > bounds.top);
	const ordered = first < 0 ? nodes.slice().reverse() : [...nodes.slice(first), ...nodes.slice(0, first).reverse()];
	if (options.anchor) ordered.unshift(options.anchor);
	return { bottom, anchors: ordered.flatMap((node) => {
		const id = node.getAttribute(attribute);
		const top = node.getBoundingClientRect().top;
		return id ? [{ id, top, offset: top - bounds.top }] : [];
	}) };
}

export function restorePlace(el: HTMLElement, selector: string, attribute: string, place: ReadingPlace) {
	if (place.bottom) { el.scrollTop = el.scrollHeight; return; }
	const nodes = [...el.querySelectorAll<HTMLElement>(selector)];
	for (const anchor of place.anchors) {
		const node = nodes.find((node) => node.getAttribute(attribute) === anchor.id && node.getBoundingClientRect().height > 0);
		if (!node) continue;
		el.scrollTop += node.getBoundingClientRect().top - anchor.top;
		return;
	}
}

export function useKeepPlace(
	scroller: RefObject<HTMLElement | null>,
	selector: string,
	attribute: string,
	pinned: RefObject<boolean>,
) {
	const saved = useRef<ReadingPlace | undefined>(undefined);
	const pending = useRef<ReadingPlace | undefined>(undefined);
	const size = useRef({ width: 0, height: 0 });
	const remember = useCallback(() => {
		const el = scroller.current;
		if (!el) return;
		if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) pinned.current = true;
		saved.current = capturePlace(el, selector, attribute, pinned.current);
		size.current = { width: el.clientWidth, height: el.clientHeight };
	}, [scroller, selector, attribute, pinned]);
	const capture = useCallback((options?: Options) => {
		const el = scroller.current;
		if (!el) return;
		const place = capturePlace(el, selector, attribute, pinned.current, options);
		pending.current = place;
		return place.anchors[0];
	}, [scroller, selector, attribute, pinned]);
	const resized = useCallback(() => {
		const el = scroller.current;
		if (!el || (el.clientWidth === size.current.width && el.clientHeight === size.current.height)) return false;
		if (saved.current) restorePlace(el, selector, attribute, saved.current);
		remember();
		return true;
	}, [scroller, selector, attribute, remember]);
	const onScroll = useCallback(() => {
		const el = scroller.current;
		if (!el || pending.current) return;
		// A layout-induced scroll event can arrive before ResizeObserver. It must not clear the old bottom pin.
		if (resized()) return;
		pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
		remember();
	}, [scroller, pinned, resized, remember]);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		if (pending.current) {
			restorePlace(el, selector, attribute, pending.current);
			pending.current = undefined;
		} else resized();
		remember();
	});
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const old = el.style.overflowAnchor;
		el.style.overflowAnchor = "none";
		const observer = new ResizeObserver(resized);
		observer.observe(el);
		return () => { observer.disconnect(); el.style.overflowAnchor = old; };
	}, [scroller, resized]);
	return { capture, onScroll };
}
