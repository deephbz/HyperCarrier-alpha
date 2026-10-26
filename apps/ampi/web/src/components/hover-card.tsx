import { useId, useLayoutEffect, useRef, useState, type DependencyList, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { scaleOf } from "../display.ts";

/**
 * A card that hover or keyboard focus opens beside its anchor. It renders in a body portal at a fixed viewport
 * position, so no container clips it and the layout never shifts. It stays open while the pointer or focus is
 * inside the anchor or the card; Escape closes it. React events from the portal bubble to the anchor.
 *
 * The card's border box stays inside the viewport with a 12 px margin: it is placed before its first painted frame and
 * again when its content, the anchor, the window, or the display size changes. Containment wins over the anchor's side;
 * a card taller than the viewport scrolls inside. AmPi sets the display size with CSS `zoom` on the page and its
 * regions (App.tsx): rects and the viewport are screen pixels, but the card's `left`, `top` and size limits are its own
 * zoomed CSS pixels, so placement converts by the card's measured scale.
 */
export function useHoverCard<T extends HTMLElement>({ prefer = "below", deps = [] }: { prefer?: "below" | "above"; deps?: DependencyList } = {}) {
	const id = useId();
	const anchor = useRef<T>(null);
	const card = useRef<HTMLElement>(null);
	const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 800, maxWidth: 800, placed: false });
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		if (!open) { setPosition((old) => old.placed ? { ...old, placed: false } : old); return; }
		const place = () => {
			const el = card.current;
			if (!anchor.current || !el) return;
			const rect = anchor.current.getBoundingClientRect();
			const box = el.getBoundingClientRect();
			const scale = scaleOf(el);
			const width = Math.min(box.width, window.innerWidth - 24);
			// The content's full height in screen pixels: scrollHeight holds the padding, offsetHeight - clientHeight the border.
			const height = Math.min((el.scrollHeight + el.offsetHeight - el.clientHeight) * scale, window.innerHeight - 24);
			const above = Math.max(0, rect.top - 12), below = Math.max(0, window.innerHeight - rect.bottom - 12);
			let left = rect.left, top = rect.bottom;
			if (above >= height && (prefer === "above" || below < height)) top = rect.top - height;
			else if (below < height) {
				top = window.innerHeight - height - 12;
				if (window.innerWidth - rect.right - 12 >= width) left = rect.right;
				else if (rect.left - 12 >= width) left = rect.left - width;
			}
			left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
			top = Math.max(12, Math.min(top, window.innerHeight - height - 12));
			const next = { left: left / scale, top: top / scale, maxHeight: height / scale, maxWidth: (window.innerWidth - 24) / scale, placed: true };
			setPosition((old) => old.left === next.left && old.top === next.top && old.maxHeight === next.maxHeight && old.maxWidth === next.maxWidth && old.placed ? old : next);
		};
		place();
		const resized = new ResizeObserver(place);
		for (const node of [card.current, anchor.current]) if (node) resized.observe(node);
		for (const name of ["resize", "ampi:display"]) window.addEventListener(name, place);
		window.addEventListener("scroll", place, true);
		document.fonts?.addEventListener("loadingdone", place);
		return () => {
			resized.disconnect();
			for (const name of ["resize", "ampi:display"]) window.removeEventListener(name, place);
			window.removeEventListener("scroll", place, true);
			document.fonts?.removeEventListener("loadingdone", place);
		};
	}, [open, prefer, ...deps]);
	const inside = (node: EventTarget | null) => node instanceof Node && Boolean(anchor.current?.contains(node) || card.current?.contains(node));
	const leave = (next: EventTarget | null) => { if (!inside(next) && !inside(document.activeElement)) setOpen(false); };
	const anchorProps = {
		ref: anchor,
		onMouseEnter: () => setOpen(true),
		onMouseLeave: (event: { relatedTarget: EventTarget | null }) => leave(event.relatedTarget),
		onFocus: () => setOpen(true),
		onBlur: (event: { relatedTarget: EventTarget | null }) => { if (!inside(event.relatedTarget)) setOpen(false); },
		onKeyDown: (event: { key: string; stopPropagation(): void }) => { if (event.key === "Escape") { setOpen(false); event.stopPropagation(); } },
	};
	const render = (label: string, content: ReactNode) => open && createPortal(
		<section className="session-metadata quiet-scroll" ref={card} style={{ position: "fixed", left: position.left, top: position.top, maxHeight: position.maxHeight, maxWidth: position.maxWidth, visibility: position.placed ? undefined : "hidden" }} id={id} aria-label={label} onMouseLeave={(event) => leave(event.relatedTarget)}>{content}</section>,
		document.body,
	);
	return { id, open, setOpen, anchorProps, render };
}
